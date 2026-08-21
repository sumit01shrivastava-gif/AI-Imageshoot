/**
 * Processing — service entry point used by routes. Mirrors
 * services/generation/request-generation.server.ts's shape:
 * `requestProcessing` is the mutating entry point for a SINGLE image (the
 * product detail page's per-image actions — see docs/image-processing.md
 * "Product detail integration"); `getProcessing`/`listProcessingHistory`
 * are the read paths; `reviewProcessingResult` records an Approve/Reject
 * decision. Batch processing (multiple images/products at once) is a
 * separate entry point — see batch.server.ts — built on the same
 * `createAndEnqueueProcessingJob` primitive this file exports.
 *
 * All entry points take an `AuthContext` and re-verify shop ownership —
 * never trust a client-supplied product/media/result id (see CLAUDE.md
 * "Security requirements").
 */
import type { ImageOperation } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { getProductIntelligence } from "../intelligence/product-intelligence.server";
import { TenantMismatchError } from "../../lib/auth/tenant.server";
import { resignResultUrls } from "../../lib/storage";
import {
  createProcessingJob,
  markQueued,
  getProcessingJob as getProcessingJobRow,
  listProcessingJobsForProduct as listProcessingJobsForProductRow,
  setResultReviewStatus,
  type ProcessingJobRow,
} from "../../db/repositories/processing-job.repository";
import { enqueueProcessingJob } from "./queue.server";
import { ImageOperationSchema, parseProcessingOptions, type ProcessingOptions } from "./schema";
import { checkEntitlement, reserveCredits, InsufficientCreditsError } from "../usage/entitlement.server";
import { getCreditCost } from "../usage/credit-costs";

export { InsufficientCreditsError };

/**
 * Deliberately the SAME error for "doesn't exist" and "belongs to another
 * shop" — see the Phase 0/1 security audit ("existence oracle" finding)
 * and services/generation/request-generation.server.ts's
 * `ProductNotFoundError`, which this mirrors.
 */
export class ProductNotFoundError extends Error {
  constructor() {
    super("Product not found");
    this.name = "ProductNotFoundError";
  }
}

export class SourceImageNotFoundError extends Error {
  constructor() {
    super("The selected image could not be found for this product.");
    this.name = "SourceImageNotFoundError";
  }
}

export class InvalidProcessingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProcessingRequestError";
  }
}

/**
 * Verifies the given product/media pair, resolves a best-effort identity
 * -anchors snapshot, and creates + enqueues one `ProcessingJob`. The
 * shared primitive both `requestProcessing` (single image) and
 * batch.server.ts's `startBatchProcessing` (many) build on — see that
 * file. `batchId`, when given, is NOT re-verified against `context.shop`
 * here — the caller (batch.server.ts) already created it under the same
 * shop in the same call.
 */
export async function createAndEnqueueProcessingJob(
  context: AuthContext,
  input: { productId: string; sourceMediaId: string; operation: ImageOperation; options: ProcessingOptions; batchId?: string },
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

  // Never trust a client-supplied media id directly — only proceed if it
  // appears in this (already shop-verified) product's own media.
  const sourceMediaExists = product.media.some((media) => media.id === input.sourceMediaId);
  if (!sourceMediaExists) {
    throw new SourceImageNotFoundError();
  }

  // Best-effort only — see prisma/schema.prisma's ProcessingJob model
  // comment ("Identity preservation"): unlike generation, processing is
  // never blocked on the product having been analyzed.
  const intelligence = await getProductIntelligence(context, product.id);
  const identityAnchors =
    intelligence && intelligence.status === "READY" ? (intelligence.identityAnchors as Record<string, unknown> | null) : null;

  // Checked BEFORE creating the job row — a request that will be denied
  // must never reach the queue at all (Part 9: "Do not allow a
  // generation request to reach the queue if credit reservation
  // fails."). One credit-worth per processing operation regardless of
  // batch size — a batch of N images is N separate reservations, one per
  // job, exactly mirroring how N separate ProcessingJob rows are created.
  const requiredCredits = getCreditCost({ operationType: "IMAGE_PROCESSING" });
  const entitlement = await checkEntitlement(context, "IMAGE_PROCESSING", requiredCredits);
  if (!entitlement.allowed) {
    throw new InsufficientCreditsError(entitlement);
  }

  const job = await createProcessingJob({
    shop: context.shop,
    productId: product.id,
    sourceMediaId: input.sourceMediaId,
    operation: input.operation,
    options: input.options,
    identityAnchors,
    batchId: input.batchId,
  });

  // Reserved right after the row exists (its id is the reservation's
  // idempotency key — see createReservation's doc comment) and BEFORE
  // enqueueing, so a worker can never start processing a job with no
  // corresponding hold.
  await reserveCredits(context, job.id, "IMAGE_PROCESSING", requiredCredits);

  await markQueued(context.shop, job.id);
  await enqueueProcessingJob({ shop: context.shop, processingJobId: job.id });

  return job;
}

export interface RequestProcessingInput {
  productId: string;
  sourceMediaId: string;
  operation: string;
  options?: unknown;
}

/** Requests processing for ONE image. ALWAYS creates a new `ProcessingJob`
 * row — this is both "Process" and "Regenerate"; a product's processing
 * history is never overwritten (see docs/image-processing.md
 * "Versioning"). */
export async function requestProcessing(context: AuthContext, input: RequestProcessingInput): Promise<{ id: string }> {
  const operationResult = ImageOperationSchema.safeParse(input.operation);
  if (!operationResult.success) {
    throw new InvalidProcessingRequestError(`Unknown processing operation "${input.operation}".`);
  }
  const options = parseProcessingOptions(input.options);

  return createAndEnqueueProcessingJob(context, {
    productId: input.productId,
    sourceMediaId: input.sourceMediaId,
    operation: operationResult.data,
    options,
  });
}

/** Re-signs a job's results' URLs fresh (see lib/storage/resign.server.ts
 * — a stored `.url` expires after an hour) before returning it to a
 * route. */
async function withFreshResultUrls(job: ProcessingJobRow): Promise<ProcessingJobRow> {
  return { ...job, results: await resignResultUrls(job.results) };
}

export async function getProcessing(context: AuthContext, id: string): Promise<ProcessingJobRow | null> {
  const job = await getProcessingJobRow(context, id);
  return job ? withFreshResultUrls(job) : null;
}

/** Most-recent-first processing history for a product — see
 * docs/image-processing.md "Versioning". */
export async function listProcessingHistory(context: AuthContext, productId: string): Promise<ProcessingJobRow[]> {
  const jobs = await listProcessingJobsForProductRow(context, productId);
  return Promise.all(jobs.map(withFreshResultUrls));
}

export type ReviewDecision = "APPROVED" | "REJECTED";

export class ProcessingResultNotFoundError extends Error {
  constructor() {
    super("Result not found");
    this.name = "ProcessingResultNotFoundError";
  }
}

/**
 * Records a merchant's Approve/Reject decision on one result — see
 * docs/image-processing.md "Result review UI". Never deletes the result
 * either way; "Regenerate" is a separate call into `requestProcessing`,
 * not a side effect of this function.
 */
export async function reviewProcessingResult(
  context: AuthContext,
  resultId: string,
  decision: ReviewDecision,
): Promise<void> {
  const updated = await setResultReviewStatus(context, resultId, decision);
  if (!updated) {
    throw new ProcessingResultNotFoundError();
  }
}
