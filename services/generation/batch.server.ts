/**
 * Batch generation — service entry point for "select multiple products →
 * choose a lifestyle preset → start generation" (see
 * docs/lifestyle-generation.md "Batch generation"). Mirrors
 * services/processing/batch.server.ts's shape and reasoning field for
 * field — see that file's own doc comment for why `ImageSelection`
 * (Phase 1) is reused rather than inventing a second selection mechanism.
 */
import type { GenerationType } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { getImageSelectionSummary } from "../products/selection.server";
import { logger } from "../../lib/logging/logger.server";
import {
  createGenerationBatch,
  getGenerationBatch,
  getGenerationBatchProgress,
  type GenerationBatchProgress,
} from "../../db/repositories/generation-batch.repository";
import { listGenerationJobsForBatch, type GenerationJobRow } from "../../db/repositories/generation-job.repository";
import { createAndEnqueueGenerationJob, ProductNotFoundError } from "./request-generation.server";
import { GenerationTypeSchema } from "./schema";

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

export interface StartBatchGenerationInput {
  selectionId: string;
  generationType: string;
  /** LIFESTYLE only — see request-generation.server.ts's
   * `CreateAndEnqueueGenerationJobInput.presetId` doc comment. Applied to
   * every job in the batch. */
  presetId?: string;
}

/**
 * Creates a `GenerationBatch` and one independent `GenerationJob` per
 * image in the given selection — mirrors `startBatchProcessing` exactly,
 * including its "one image's job failing to even be CREATED must not
 * abort the whole batch" handling (see that function's doc comment for
 * the full reasoning; the only realistic trigger is a genuine race, e.g.
 * the product being removed between the selection being saved and the
 * batch starting).
 */
export async function startBatchGeneration(
  context: AuthContext,
  input: StartBatchGenerationInput,
): Promise<{ batchId: string; jobCount: number }> {
  const typeResult = GenerationTypeSchema.safeParse(input.generationType);
  if (!typeResult.success) {
    throw new InvalidBatchRequestError(`Unknown generation type "${input.generationType}".`);
  }

  const summary = await getImageSelectionSummary(context, input.selectionId);
  if (!summary) {
    throw new SelectionNotFoundError();
  }
  if (summary.imageCount === 0) {
    throw new InvalidBatchRequestError("This selection has no images.");
  }

  const batch = await createGenerationBatch({
    shop: context.shop,
    generationType: typeResult.data as GenerationType,
    sourceSelectionId: input.selectionId,
  });

  let jobCount = 0;
  for (const product of summary.products) {
    for (const image of product.images) {
      try {
        await createAndEnqueueGenerationJob(context, {
          productId: product.productId,
          generationType: typeResult.data,
          sourceMediaIds: [image.productMediaId],
          presetId: input.presetId,
          batchId: batch.id,
        });
        jobCount += 1;
      } catch (error) {
        // One image failing to even start must not abort the batch — see
        // module doc comment. ProductNotFoundError/ProductNotAnalyzedError/
        // MissingSourceImagesError here would mean the product was
        // removed, was never analyzed, or its media changed after the
        // selection was saved; still just skip-and-log, not fail the
        // whole request.
        logger.warn("generation.batch.job_creation_failed", {
          shop: context.shop,
          batchId: batch.id,
          productId: product.productId,
          sourceMediaId: image.productMediaId,
          error:
            error instanceof ProductNotFoundError
              ? "product not found"
              : error instanceof Error
                ? error.message
                : "unknown error",
        });
      }
    }
  }

  logger.info("generation.batch.started", {
    shop: context.shop,
    batchId: batch.id,
    generationType: typeResult.data,
    jobCount,
  });

  return { batchId: batch.id, jobCount };
}

export interface GenerationBatchSummary {
  id: string;
  generationType: GenerationType;
  createdAt: Date;
  progress: GenerationBatchProgress;
  jobs: GenerationJobRow[];
}

export async function getGenerationBatchSummary(
  context: AuthContext,
  batchId: string,
): Promise<GenerationBatchSummary | null> {
  const batch = await getGenerationBatch(context, batchId);
  if (!batch) return null;
  const [progress, jobs] = await Promise.all([
    getGenerationBatchProgress(batch.id),
    listGenerationJobsForBatch(context.shop, batch.id),
  ]);
  return { id: batch.id, generationType: batch.generationType, createdAt: batch.createdAt, progress, jobs };
}
