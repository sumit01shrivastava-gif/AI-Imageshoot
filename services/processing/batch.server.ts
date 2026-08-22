/**
 * Batch processing — service entry point for "select multiple products →
 * choose operation → start processing" (see docs/image-processing.md
 * "Batch processing").
 *
 * Deliberately reuses Phase 1's `ImageSelection` (see
 * services/products/selection.server.ts) as the source of "which
 * products/images" rather than inventing a second selection mechanism —
 * that model was built specifically so "a future phase" could consume a
 * concrete, server-validated selection instead of only ever-transient
 * browser state (see prisma/schema.prisma's `ImageSelection` model
 * comment). This phase is that future phase.
 */
import type { ImageOperation } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { getImageSelectionSummary } from "../products/selection.server";
import { logger } from "../../lib/logging/logger.server";
import { resignResultUrls } from "../../lib/storage";
import { createBatch, getBatch, getBatchProgress, type BatchProgress } from "../../db/repositories/processing-batch.repository";
import { listProcessingJobsForBatch, type ProcessingJobRow } from "../../db/repositories/processing-job.repository";
import { createAndEnqueueProcessingJob, ProductNotFoundError } from "./request-processing.server";
import { ImageOperationSchema, parseProcessingOptions } from "./schema";
import { assertWithinBatchLimit, PlanLimitExceededError } from "../usage/entitlement.server";

export { PlanLimitExceededError };

export class SelectionNotFoundError extends Error {
  constructor() {
    super("Selection not found");
    this.name = "SelectionNotFoundError";
  }
}

export class InvalidBatchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBatchRequestError";
  }
}

export interface StartBatchProcessingInput {
  selectionId: string;
  operation: string;
  options?: unknown;
}

/**
 * Creates a `ProcessingBatch` and one independent `ProcessingJob` per
 * image in the given selection. One image's job failing to even be
 * CREATED (e.g. its media was deleted between the selection being saved
 * and the batch starting) is logged and skipped, not allowed to abort
 * the whole batch — see the section-12 requirement "one product failing
 * must not fail the entire batch". A job that's created but later fails
 * DURING processing is inherently independent already (each is its own
 * row/queue job) — see docs/image-processing.md "Batch processing".
 */
export async function startBatchProcessing(
  context: AuthContext,
  input: StartBatchProcessingInput,
): Promise<{ batchId: string; jobCount: number }> {
  const operationResult = ImageOperationSchema.safeParse(input.operation);
  if (!operationResult.success) {
    throw new InvalidBatchRequestError(`Unknown processing operation "${input.operation}".`);
  }
  const options = parseProcessingOptions(input.options);

  const summary = await getImageSelectionSummary(context, input.selectionId);
  if (!summary) {
    throw new SelectionNotFoundError();
  }
  if (summary.imageCount === 0) {
    throw new InvalidBatchRequestError("This selection has no images.");
  }
  // Plan batch-size limit — checked BEFORE creating the batch row or any
  // job (see services/usage/entitlement.server.ts's `assertWithinBatchLimit`
  // and docs/billing.md "Plan limit enforcement").
  await assertWithinBatchLimit(context.shop, summary.imageCount);

  const batch = await createBatch({
    shop: context.shop,
    operation: operationResult.data,
    sourceSelectionId: input.selectionId,
  });

  let jobCount = 0;
  for (const product of summary.products) {
    for (const image of product.images) {
      try {
        await createAndEnqueueProcessingJob(context, {
          productId: product.productId,
          sourceMediaId: image.productMediaId,
          operation: operationResult.data,
          options,
          batchId: batch.id,
        });
        jobCount += 1;
      } catch (error) {
        // One image failing to even start must not abort the batch — see
        // module doc comment. ProductNotFoundError here would mean the
        // product was removed after the selection was saved; still just
        // skip-and-log, not fail the whole request.
        logger.warn("processing.batch.job_creation_failed", {
          shop: context.shop,
          batchId: batch.id,
          productId: product.productId,
          sourceMediaId: image.productMediaId,
          error: error instanceof ProductNotFoundError ? "product not found" : error instanceof Error ? error.message : "unknown error",
        });
      }
    }
  }

  logger.info("processing.batch.started", {
    shop: context.shop,
    batchId: batch.id,
    operation: operationResult.data,
    jobCount,
  });

  return { batchId: batch.id, jobCount };
}

export interface BatchSummary {
  id: string;
  operation: ImageOperation;
  createdAt: Date;
  progress: BatchProgress;
  jobs: ProcessingJobRow[];
}

export async function getBatchSummary(context: AuthContext, batchId: string): Promise<BatchSummary | null> {
  const batch = await getBatch(context, batchId);
  if (!batch) return null;
  const [progress, rawJobs] = await Promise.all([
    getBatchProgress(batch.id),
    listProcessingJobsForBatch(context.shop, batch.id),
  ]);
  const jobs = await Promise.all(rawJobs.map(async (job) => ({ ...job, results: await resignResultUrls(job.results) })));
  return { id: batch.id, operation: batch.operation, createdAt: batch.createdAt, progress, jobs };
}
