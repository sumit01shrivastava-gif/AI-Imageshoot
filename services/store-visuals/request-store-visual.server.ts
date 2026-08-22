/**
 * Store visuals — service entry point used by routes. Mirrors
 * services/generation/request-generation.server.ts's shape:
 * `requestStoreVisual` is the mutating entry point (resolves products/
 * preset, builds the plan, creates + enqueues the job);
 * `getStoreVisual`/`listStoreVisualHistory` are the read paths;
 * `reviewStoreVisualResult` records an Approve/Reject decision. All
 * entry points take an `AuthContext` and re-verify shop ownership — never
 * trust a client-supplied product/result id (see CLAUDE.md "Security
 * requirements").
 */
import type { StoreVisualType, ReviewStatus } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { getProductIntelligence } from "../intelligence/product-intelligence.server";
import { TenantMismatchError } from "../../lib/auth/tenant.server";
import { resignResultUrls } from "../../lib/storage";
import {
  createStoreVisualJob,
  markQueued,
  getStoreVisualJob as getStoreVisualJobRow,
  listStoreVisualJobsForShop,
  setStoreVisualResultReviewStatus,
  type StoreVisualJobRow,
  type StoreVisualJobListFilters,
  type StoreVisualJobListPage,
} from "../../db/repositories/store-visual-job.repository";
import { buildStoreVisualPlan, type StoreVisualProductInput } from "./build-plan";
import { resolveBrandStylePreset } from "../generation/brand-style-preset.server";
import { enqueueStoreVisualJob } from "./queue.server";
import { StoreVisualTypeSchema, AspectRatioSchema } from "./schema";
import type { AspectRatioValue } from "./types";
import { checkEntitlement, reserveCredits, InsufficientCreditsError, assertWithinOutputLimit, PlanLimitExceededError } from "../usage/entitlement.server";
import { getCreditCost } from "../usage/credit-costs";

export { InsufficientCreditsError, PlanLimitExceededError };

export class InvalidStoreVisualRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStoreVisualRequestError";
  }
}

/** Same "doesn't exist" vs. "belongs to another shop" existence-oracle
 * prevention every other domain in this app uses — see
 * services/generation/request-generation.server.ts's identical
 * `ProductNotFoundError`. Deliberately named per-domain (not imported from
 * services/generation/) so each domain's error stays independently
 * catchable at its own route boundary. */
export class ProductNotFoundError extends Error {
  constructor() {
    super("Product not found");
    this.name = "ProductNotFoundError";
  }
}

export class StoreVisualResultNotFoundError extends Error {
  constructor() {
    super("Store visual result not found");
    this.name = "StoreVisualResultNotFoundError";
  }
}

export interface RequestStoreVisualInput {
  visualType: string;
  /** Zero, one, or several of this shop's own products to feature —
   * never trusted directly: each id is resolved via `findProductForShop`
   * (shop-verified) before use. Unlike a batch's "skip and continue on
   * one failure," a bad id here fails the WHOLE request with
   * `ProductNotFoundError` — this is one deliberate, merchant-chosen
   * selection, not an independent-items batch. */
  productIds?: string[];
  presetId?: string;
  aspectRatio?: string;
}

/**
 * Resolves the optional product references + brand style preset, builds
 * a `StoreVisualPlan`, and creates + enqueues one `StoreVisualJob`.
 * ALWAYS creates a new row — this is both "Generate" and "Regenerate";
 * store-visual history is never overwritten, mirroring
 * docs/generation.md "Generation history" exactly.
 */
export async function requestStoreVisual(
  context: AuthContext,
  input: RequestStoreVisualInput,
): Promise<{ id: string }> {
  const typeResult = StoreVisualTypeSchema.safeParse(input.visualType);
  if (!typeResult.success) {
    throw new InvalidStoreVisualRequestError(`Unknown store visual type "${input.visualType}".`);
  }

  let aspectRatioOverride: AspectRatioValue | undefined;
  if (input.aspectRatio !== undefined) {
    const aspectRatioResult = AspectRatioSchema.safeParse(input.aspectRatio);
    if (!aspectRatioResult.success) {
      throw new InvalidStoreVisualRequestError(`Unknown aspect ratio "${input.aspectRatio}".`);
    }
    aspectRatioOverride = aspectRatioResult.data;
  }

  const productIds = input.productIds ?? [];
  const products: StoreVisualProductInput[] = [];
  for (const productId of productIds) {
    let product: Awaited<ReturnType<typeof findProductForShop>>;
    try {
      product = await findProductForShop(context, productId);
    } catch (error) {
      if (error instanceof TenantMismatchError) {
        throw new ProductNotFoundError();
      }
      throw error;
    }
    if (!product) {
      throw new ProductNotFoundError();
    }
    // Best-effort — a store visual is never blocked on a referenced
    // product's analysis (see build-plan.ts's doc comment).
    const intelligence = await getProductIntelligence(context, product.id);
    products.push({ product, intelligence });
  }

  const brandStylePreset = input.presetId ? await resolveBrandStylePreset(context, input.presetId) : null;

  const plan = buildStoreVisualPlan({
    visualType: typeResult.data,
    products,
    brandStylePreset,
    aspectRatioOverride,
  });

  // Plan output-count limit — same field/reasoning as
  // services/generation/request-generation.server.ts's identical check
  // (see services/usage/entitlement.server.ts's `assertWithinOutputLimit`).
  await assertWithinOutputLimit(context.shop, plan.outputCount);

  // Checked BEFORE creating the job row — see
  // services/processing/request-processing.server.ts's identical
  // reasoning (Part 9: a request that will be denied must never reach
  // the queue).
  const requiredCredits = getCreditCost({ operationType: "STORE_VISUAL_GENERATION", outputCount: plan.outputCount });
  const entitlement = await checkEntitlement(context, "STORE_VISUAL_GENERATION", requiredCredits);
  if (!entitlement.allowed) {
    throw new InsufficientCreditsError(entitlement);
  }

  const job = await createStoreVisualJob({
    shop: context.shop,
    type: typeResult.data as StoreVisualType,
    plan,
    productIds: products.map((p) => p.product.id),
  });

  await reserveCredits(context, job.id, "STORE_VISUAL_GENERATION", requiredCredits);

  await markQueued(context.shop, job.id);
  await enqueueStoreVisualJob({ shop: context.shop, storeVisualJobId: job.id });

  return job;
}

/** Re-signs a job's results' URLs fresh (see lib/storage/resign.server.ts
 * — a stored `.url` expires after an hour) before returning it to a
 * route. */
async function withFreshResultUrls(job: StoreVisualJobRow): Promise<StoreVisualJobRow> {
  return { ...job, results: await resignResultUrls(job.results) };
}

export async function getStoreVisual(context: AuthContext, id: string): Promise<StoreVisualJobRow | null> {
  const job = await getStoreVisualJobRow(context, id);
  return job ? withFreshResultUrls(job) : null;
}

/** Shop-wide, paginated, most-recent-first store-visual history — unlike
 * `services/generation/`'s per-PRODUCT history, a store visual has no
 * single owning product to scope by. See docs/store-visuals.md. */
export async function listStoreVisualHistory(
  context: AuthContext,
  filters: StoreVisualJobListFilters,
  page: number,
): Promise<StoreVisualJobListPage> {
  const result = await listStoreVisualJobsForShop(context, filters, page);
  return { ...result, jobs: await Promise.all(result.jobs.map(withFreshResultUrls)) };
}

export async function reviewStoreVisualResult(
  context: AuthContext,
  resultId: string,
  reviewStatus: Exclude<ReviewStatus, "PENDING">,
): Promise<void> {
  const updated = await setStoreVisualResultReviewStatus(context, resultId, reviewStatus);
  if (!updated) {
    throw new StoreVisualResultNotFoundError();
  }
}
