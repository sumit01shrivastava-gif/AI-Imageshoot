/**
 * Generation — service entry point used by routes. Mirrors
 * services/intelligence/product-intelligence.server.ts's shape:
 * `requestGeneration` is the mutating entry point (builds a plan, creates a
 * job row, enqueues it); `getGeneration`/`listGenerationHistory` are the
 * read paths. All three take an `AuthContext` and re-verify shop ownership
 * — never trust a client-supplied product id (see CLAUDE.md "Security
 * requirements").
 */
import type { GenerationType } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { getProductIntelligence } from "../intelligence/product-intelligence.server";
import { TenantMismatchError } from "../../lib/auth/tenant.server";
import {
  createGenerationJob,
  markQueued,
  getGenerationJob as getGenerationJobRow,
  listGenerationJobsForProduct as listGenerationJobsForProductRow,
  type GenerationJobRow,
} from "../../db/repositories/generation-job.repository";
import { buildGenerationPlan, type BuildGenerationPlanInput } from "./build-plan";
import { enqueueGenerationJob } from "./queue.server";
import { GenerationTypeSchema } from "./schema";

/**
 * Deliberately the SAME error for "doesn't exist" and "belongs to another
 * shop" — see the Phase 0/1 security audit ("existence oracle" finding)
 * and services/intelligence/product-intelligence.server.ts's
 * `ProductNotFoundError`, which this mirrors.
 */
export class ProductNotFoundError extends Error {
  constructor() {
    super("Product not found");
    this.name = "ProductNotFoundError";
  }
}

export class InvalidGenerationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGenerationRequestError";
  }
}

export { MissingSourceImagesError, ProductNotAnalyzedError } from "./build-plan";

export interface RequestGenerationInput {
  productId: string;
  generationType: string;
  /** Our internal `ShopifyProductMedia` ids to generate from. Omitted (or
   * empty) defaults to every one of the product's current media — what
   * the minimal "Generate Test Image" button uses, since it has no image
   * picker of its own (see docs/generation.md "UI"). Never trusted
   * directly: `buildGenerationPlan` only ever uses ids that appear in the
   * shop-verified `product.media`. */
  sourceMediaIds?: string[];
  /** See build-plan.ts's `visualDirectionOverride` doc comment — never set
   * by the merchant-facing route (see docs/generation.md "No arbitrary
   * prompts"); exists so tests can exercise the deterministic provider's
   * forced-failure hook. */
  visualDirectionOverride?: BuildGenerationPlanInput["visualDirectionOverride"];
  /** See build-plan.ts's `outputCountOverride` doc comment — never set by
   * the merchant-facing route; exists so tests can exercise multi-result
   * storage/persistence through the real pipeline. */
  outputCountOverride?: number;
}

/**
 * Requests a new generation. ALWAYS creates a new `GenerationJob` row —
 * this is both "Generate" and "Regenerate"; there is no separate
 * "overwrite the current generation" path, so generation history is never
 * lost (see docs/generation.md "Generation history").
 *
 * `markQueued` runs BEFORE `enqueueGenerationJob` returns control here —
 * deliberately, not after: the worker could start (and advance status to
 * PROCESSING/SUCCEEDED) as soon as the job is enqueued, so writing QUEUED
 * afterwards would risk a stale write clobbering a newer status back to
 * QUEUED. Marking QUEUED first, then enqueuing, makes that race
 * impossible — by the time the worker can possibly see the job, the row
 * already reads QUEUED.
 */
export async function requestGeneration(
  context: AuthContext,
  input: RequestGenerationInput,
): Promise<{ id: string }> {
  const typeResult = GenerationTypeSchema.safeParse(input.generationType);
  if (!typeResult.success) {
    throw new InvalidGenerationRequestError(`Unknown generation type "${input.generationType}".`);
  }

  let product: Awaited<ReturnType<typeof findProductForShop>>;
  try {
    product = await findProductForShop(context, input.productId);
  } catch (error) {
    if (error instanceof TenantMismatchError) {
      throw new ProductNotFoundError();
    }
    throw error;
  }
  if (!product) {
    throw new ProductNotFoundError();
  }

  // Source media ids are never trusted directly — buildGenerationPlan only
  // ever uses ids that appear in `product.media` (already shop-verified
  // above), silently dropping anything else; if that leaves zero images it
  // throws MissingSourceImagesError rather than proceeding. An
  // empty/omitted list (the minimal "Generate Test Image" button's case —
  // see RequestGenerationInput's doc comment) defaults to every one of the
  // product's current media.
  const sourceMediaIds =
    input.sourceMediaIds && input.sourceMediaIds.length > 0
      ? input.sourceMediaIds
      : product.media.map((media) => media.id);

  const intelligence = await getProductIntelligence(context, product.id);

  const plan = buildGenerationPlan({
    product,
    intelligence,
    sourceMediaIds,
    generationType: typeResult.data,
    visualDirectionOverride: input.visualDirectionOverride,
    outputCountOverride: input.outputCountOverride,
  });

  const job = await createGenerationJob({
    shop: context.shop,
    productId: product.id,
    type: typeResult.data as GenerationType,
    sourceMediaIds,
    plan,
  });

  await markQueued(context.shop, job.id);
  await enqueueGenerationJob({ shop: context.shop, generationJobId: job.id });

  return job;
}

export async function getGeneration(context: AuthContext, id: string): Promise<GenerationJobRow | null> {
  return getGenerationJobRow(context, id);
}

/** Most-recent-first generation history for a product — see
 * docs/generation.md "Generation history". */
export async function listGenerationHistory(context: AuthContext, productId: string): Promise<GenerationJobRow[]> {
  return listGenerationJobsForProductRow(context, productId);
}
