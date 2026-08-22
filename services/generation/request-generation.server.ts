/**
 * Generation — service entry point used by routes. Mirrors
 * services/processing/request-processing.server.ts's shape:
 * `createAndEnqueueGenerationJob` is the shared primitive (resolves the
 * product/preset, builds the plan, creates + enqueues the job) that both
 * `requestGeneration` (single-product, the product detail page) and
 * services/generation/batch.server.ts's `startBatchGeneration` (many, one
 * per selected image) build on; `getGeneration`/`listGenerationHistory`
 * are the read paths; `reviewGenerationResult` records an Approve/Reject
 * decision. All entry points take an `AuthContext` and re-verify shop
 * ownership — never trust a client-supplied product/result id (see
 * CLAUDE.md "Security requirements").
 */
import type { GenerationType, ReviewStatus } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { getProductIntelligence } from "../intelligence/product-intelligence.server";
import { TenantMismatchError } from "../../lib/auth/tenant.server";
import { resignResultUrls } from "../../lib/storage";
import {
  createGenerationJob,
  markQueued,
  getGenerationJob as getGenerationJobRow,
  listGenerationJobsForProduct as listGenerationJobsForProductRow,
  setGenerationResultReviewStatus,
  type GenerationJobRow,
} from "../../db/repositories/generation-job.repository";
import { buildGenerationPlan, type BuildGenerationPlanInput } from "./build-plan";
import { resolveBrandStylePreset } from "./brand-style-preset.server";
import { enqueueGenerationJob } from "./queue.server";
import { GenerationTypeSchema, AspectRatioSchema, type GenerationPlan } from "./schema";
import type { GenerationTypeValue, AspectRatioValue } from "./types";
import { checkEntitlement, reserveCredits, InsufficientCreditsError, assertWithinOutputLimit, PlanLimitExceededError } from "../usage/entitlement.server";
import { getCreditCost } from "../usage/credit-costs";
import type { GenerationMode } from "../ai/types";

export { InsufficientCreditsError, PlanLimitExceededError };

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

/** Deliberately the same "not found" shape a missing/foreign-shop result
 * gets — see ProductNotFoundError's doc comment (existence-oracle
 * prevention). */
export class GenerationResultNotFoundError extends Error {
  constructor() {
    super("Generation result not found");
    this.name = "GenerationResultNotFoundError";
  }
}

export { MissingSourceImagesError, ProductNotAnalyzedError, ProductNotModelSuitableError } from "./build-plan";

export interface CreateAndEnqueueGenerationJobInput {
  productId: string;
  generationType: GenerationTypeValue;
  /** Our internal `ShopifyProductMedia` ids to generate from. Never
   * trusted directly: `buildGenerationPlan` only ever uses ids that
   * appear in the shop-verified `product.media`. */
  sourceMediaIds: string[];
  /** See build-plan.ts's `visualDirectionOverride` doc comment — never set
   * by the merchant-facing route (see docs/generation.md "No arbitrary
   * prompts"); exists so tests can exercise the deterministic provider's
   * forced-failure hook. */
  visualDirectionOverride?: BuildGenerationPlanInput["visualDirectionOverride"];
  /** See build-plan.ts's `outputCountOverride` doc comment — never set by
   * the merchant-facing route; exists so tests can exercise multi-result
   * storage/persistence through the real pipeline. */
  outputCountOverride?: number;
  /** LIFESTYLE/MODEL_SHOOT only — id of a brand style preset (built-in or
   * this shop's own custom one) to resolve and apply. Ignored for every
   * other generationType. An id that resolves to nothing (unknown, or
   * another shop's custom preset) is NOT an error — it silently falls
   * back to category-aware defaults (see build-plan.ts/lifestyle-scene.ts),
   * the same as passing no preset at all; a bad/stale id should never
   * block generation. */
  presetId?: string;
  /** LIFESTYLE only — structured merchant scene-control overrides (never
   * a free-text prompt — see docs/generation.md "No arbitrary prompts").
   * Ignored for every other generationType. */
  lifestyleSceneOverride?: BuildGenerationPlanInput["lifestyleSceneOverride"];
  /** A curated aspect ratio (see build-plan.ts's `aspectRatioOverride` doc
   * comment) — applies to every generationType. Defaults to "1:1" when
   * omitted. */
  aspectRatioOverride?: AspectRatioValue;
  /** Set only when this request is part of a batch (see
   * services/generation/batch.server.ts) — groups the resulting
   * `GenerationJob` under a `GenerationBatch` for progress tracking. Never
   * set by a single-product request. `batchId` is NOT re-verified against
   * `context.shop` here — the caller (batch.server.ts) already created it
   * under the same shop in the same call (mirrors
   * createAndEnqueueProcessingJob's identical doc comment). */
  batchId?: string;
  /** Set only by services/creative-studio/session.server.ts — groups the
   * resulting `GenerationJob` under a `CreativeSession`. Not re-verified
   * against `context.shop` here for the same reason `batchId` isn't (the
   * caller already created/loaded it under the same shop). */
  creativeSessionId?: string;
  /** When provided, skips `buildGenerationPlan` (and the
   * intelligence/preset lookups it needs) entirely and uses this
   * already-built, already-validated plan as-is. Exists for
   * services/creative-studio/plan-builder.ts, whose input shape (a
   * conversational instruction + resolved session context) doesn't fit
   * `buildGenerationPlan`'s per-generationType branches — but the
   * resulting `GenerationJob`/queue/worker/storage pipeline is identical
   * either way (see that file's doc comment for why this is "reuse the
   * existing GenerationPlan architecture," not a second one). */
  planOverride?: GenerationPlan;
  /** Called after the `GenerationJob` row is created but BEFORE it's
   * marked QUEUED/enqueued — the one safe window to do something keyed on
   * the job's own id before a worker could possibly start processing it
   * (mirrors why `markQueued` itself runs before `enqueueGenerationJob`
   * returns control here). services/creative-studio/session.server.ts
   * uses this to reserve generation credits
   * (services/usage/entitlement.server.ts) against the real job id —
   * never a generic "credit-aware generation" concept baked into this
   * shared primitive itself, which every other generationType also goes
   * through unchanged. */
  beforeEnqueue?: (jobId: string) => Promise<void>;
}

/**
 * Resolves the product/Product Intelligence/preset, builds a
 * `GenerationPlan`, and creates + enqueues one `GenerationJob`. The shared
 * primitive both `requestGeneration` (single product) and
 * batch.server.ts's `startBatchGeneration` (many, one per selected image)
 * build on — see that file. ALWAYS creates a new `GenerationJob` row —
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
export async function createAndEnqueueGenerationJob(
  context: AuthContext,
  input: CreateAndEnqueueGenerationJobInput,
): Promise<{ id: string }> {
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

  let plan: GenerationPlan;
  if (input.planOverride) {
    plan = input.planOverride;
  } else {
    const intelligence = await getProductIntelligence(context, product.id);

    // Preset resolution only matters for LIFESTYLE (build-plan.ts ignores
    // brandStylePreset for every other generationType) — but resolving it
    // unconditionally here keeps this function simple; an id irrelevant to
    // a non-LIFESTYLE request is just unused, never an error.
    const brandStylePreset = input.presetId ? await resolveBrandStylePreset(context, input.presetId) : null;

    plan = buildGenerationPlan({
      product,
      intelligence,
      sourceMediaIds: input.sourceMediaIds,
      generationType: input.generationType,
      visualDirectionOverride: input.visualDirectionOverride,
      outputCountOverride: input.outputCountOverride,
      brandStylePreset,
      lifestyleSceneOverride: input.lifestyleSceneOverride,
      aspectRatioOverride: input.aspectRatioOverride,
    });
  }

  // Plan output-count limit — applies to EVERY generationType,
  // including Creative Studio (unlike the credit-gate block below, this
  // isn't skipped for a Creative-Studio-managed request; output-count
  // enforcement is a different concern from credit-reservation
  // ownership). See services/usage/entitlement.server.ts's
  // `assertWithinOutputLimit` and docs/billing.md "Plan limit
  // enforcement".
  await assertWithinOutputLimit(context.shop, plan.outputCount);

  // Credit-gate every generationType EXCEPT Creative Studio, which
  // already checks/reserves its own credits (services/creative-studio/session.server.ts,
  // BEFORE this function is even called — it needs to fail fast without
  // first writing chat messages) and passes its reservation through its
  // own `beforeEnqueue` hook below. Reserving here too for a Creative
  // Studio job would double-charge it. See docs/usage.md's domain table.
  const isCreativeStudioManaged = Boolean(input.creativeSessionId);
  let requiredCredits = 0;
  if (!isCreativeStudioManaged) {
    requiredCredits = getCreditCost({
      operationType: "IMAGE_GENERATION",
      // `plan.creativeIntent.mode` is typed as a plain string in
      // services/generation/schema.ts (that module deliberately doesn't
      // import Creative Studio's concrete GenerationModeValue enum — see
      // its own domain-boundary comment) but is only ever populated from
      // the validated enum in the first place (plan-builder.ts) — safe
      // to narrow here, at this credit-cost-lookup boundary only.
      mode: plan.creativeIntent?.mode as GenerationMode | undefined,
      outputCount: plan.outputCount,
    });
    const entitlement = await checkEntitlement(context, "IMAGE_GENERATION", requiredCredits);
    if (!entitlement.allowed) {
      throw new InsufficientCreditsError(entitlement);
    }
  }

  const job = await createGenerationJob({
    shop: context.shop,
    productId: product.id,
    type: input.generationType as GenerationType,
    sourceMediaIds: input.sourceMediaIds,
    plan,
    batchId: input.batchId,
    creativeSessionId: input.creativeSessionId,
  });

  if (!isCreativeStudioManaged) {
    await reserveCredits(context, job.id, "IMAGE_GENERATION", requiredCredits);
  }

  if (input.beforeEnqueue) {
    await input.beforeEnqueue(job.id);
  }

  await markQueued(context.shop, job.id);
  await enqueueGenerationJob({ shop: context.shop, generationJobId: job.id });

  return job;
}

export interface RequestGenerationInput {
  productId: string;
  generationType: string;
  /** Our internal `ShopifyProductMedia` ids to generate from. Omitted (or
   * empty) defaults to every one of the product's current media — what
   * the minimal "Generate Test Image" button uses, since it has no image
   * picker of its own (see docs/generation.md "UI"). */
  sourceMediaIds?: string[];
  visualDirectionOverride?: BuildGenerationPlanInput["visualDirectionOverride"];
  outputCountOverride?: number;
  presetId?: string;
  lifestyleSceneOverride?: BuildGenerationPlanInput["lifestyleSceneOverride"];
  /** A raw, client-supplied aspect ratio string — validated against
   * `ASPECT_RATIOS` here (never trusted/forwarded unchecked); an unknown
   * value throws `InvalidGenerationRequestError` rather than silently
   * falling back, since — unlike a stale presetId — a merchant selecting
   * from a fixed dropdown should never actually be able to submit one. */
  aspectRatio?: string;
  batchId?: string;
}

/** Requests generation for a single product (the product detail page's
 * Generate/Regenerate buttons). Validates `generationType` and
 * `aspectRatio`, then resolves `sourceMediaIds` (never trusted directly —
 * only ids that appear in the shop-verified product's own media are kept;
 * empty/omitted defaults to every one of the product's current media)
 * before delegating to the shared `createAndEnqueueGenerationJob`
 * primitive. */
export async function requestGeneration(
  context: AuthContext,
  input: RequestGenerationInput,
): Promise<{ id: string }> {
  const typeResult = GenerationTypeSchema.safeParse(input.generationType);
  if (!typeResult.success) {
    throw new InvalidGenerationRequestError(`Unknown generation type "${input.generationType}".`);
  }

  let aspectRatioOverride: AspectRatioValue | undefined;
  if (input.aspectRatio !== undefined) {
    const aspectRatioResult = AspectRatioSchema.safeParse(input.aspectRatio);
    if (!aspectRatioResult.success) {
      throw new InvalidGenerationRequestError(`Unknown aspect ratio "${input.aspectRatio}".`);
    }
    aspectRatioOverride = aspectRatioResult.data;
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

  const sourceMediaIds =
    input.sourceMediaIds && input.sourceMediaIds.length > 0
      ? input.sourceMediaIds
      : product.media.map((media) => media.id);

  return createAndEnqueueGenerationJob(context, {
    productId: input.productId,
    generationType: typeResult.data,
    sourceMediaIds,
    visualDirectionOverride: input.visualDirectionOverride,
    outputCountOverride: input.outputCountOverride,
    presetId: input.presetId,
    lifestyleSceneOverride: input.lifestyleSceneOverride,
    aspectRatioOverride,
    batchId: input.batchId,
  });
}

/** Re-signs a job's results' URLs fresh (see lib/storage/resign.server.ts
 * — a stored `.url` expires after an hour) before returning it to a
 * route. Every read path in this module goes through this rather than
 * returning the repository row's URLs as-is. */
async function withFreshResultUrls(job: GenerationJobRow): Promise<GenerationJobRow> {
  return { ...job, results: await resignResultUrls(job.results) };
}

export async function getGeneration(context: AuthContext, id: string): Promise<GenerationJobRow | null> {
  const job = await getGenerationJobRow(context, id);
  return job ? withFreshResultUrls(job) : null;
}

/** Most-recent-first generation history for a product — see
 * docs/generation.md "Generation history". */
export async function listGenerationHistory(context: AuthContext, productId: string): Promise<GenerationJobRow[]> {
  const jobs = await listGenerationJobsForProductRow(context, productId);
  return Promise.all(jobs.map(withFreshResultUrls));
}

/**
 * Approve/reject one generation result. Never mutates or deletes the
 * result itself — see db/repositories/generation-job.repository.ts's
 * `setGenerationResultReviewStatus`, which this wraps. Throws
 * `GenerationResultNotFoundError` for a result that doesn't exist or
 * belongs to another shop — the same safe 404 shape every other
 * not-found case in this module uses.
 */
export async function reviewGenerationResult(
  context: AuthContext,
  resultId: string,
  reviewStatus: Exclude<ReviewStatus, "PENDING">,
): Promise<void> {
  const updated = await setGenerationResultReviewStatus(context, resultId, reviewStatus);
  if (!updated) {
    throw new GenerationResultNotFoundError();
  }
}
