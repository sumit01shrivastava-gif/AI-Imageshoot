/**
 * Repository for `GenerationBatch` — see db/repositories/README.md and
 * prisma/schema.prisma's model comment (progress is computed, not
 * persisted — see `getGenerationBatchProgress` below). Field-for-field
 * mirror of db/repositories/processing-batch.repository.ts — see
 * docs/lifestyle-generation.md for why this is a separate model/
 * repository rather than reusing ProcessingBatch's.
 */
import type { GenerationType } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";

export interface CreateGenerationBatchInput {
  shop: string;
  generationType: GenerationType;
  sourceSelectionId?: string;
}

export async function createGenerationBatch(input: CreateGenerationBatchInput): Promise<{ id: string }> {
  return prisma.generationBatch.create({
    data: {
      shop: input.shop,
      generationType: input.generationType,
      sourceSelectionId: input.sourceSelectionId,
    },
    select: { id: true },
  });
}

export interface GenerationBatchRow {
  id: string;
  shop: string;
  generationType: GenerationType;
  createdAt: Date;
}

/** Loads one batch's own row (not its jobs — see
 * `getGenerationBatchProgress`/`listGenerationJobsForBatch` for job-level
 * detail), verifying shop ownership. */
export async function getGenerationBatch(context: AuthContext, id: string): Promise<GenerationBatchRow | null> {
  const row = await prisma.generationBatch.findUnique({
    where: { id },
    select: { id: true, shop: true, generationType: true, createdAt: true },
  });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

export interface GenerationBatchProgress {
  total: number;
  pending: number;
  queued: number;
  processing: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

const EMPTY_PROGRESS: GenerationBatchProgress = {
  total: 0,
  pending: 0,
  queued: 0,
  processing: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
};

/**
 * Computed at read time via a `groupBy` over `GenerationJob.status`
 * scoped to this batch — never a persisted counter, so it can never
 * drift from the jobs it's summarizing (same "derive, don't duplicate"
 * principle as `getBatchProgress`/`services/intelligence/stale.ts`).
 * Ownership isn't separately checked here — callers first load the batch
 * via `getGenerationBatch` (which does check), then call this with the
 * id it already verified.
 */
export async function getGenerationBatchProgress(batchId: string): Promise<GenerationBatchProgress> {
  const groups = await prisma.generationJob.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { status: true },
  });

  const progress = { ...EMPTY_PROGRESS };
  for (const group of groups) {
    const count = group._count.status;
    progress.total += count;
    switch (group.status) {
      case "PENDING":
        progress.pending = count;
        break;
      case "QUEUED":
        progress.queued = count;
        break;
      case "PROCESSING":
        progress.processing = count;
        break;
      case "SUCCEEDED":
        progress.succeeded = count;
        break;
      case "FAILED":
        progress.failed = count;
        break;
      case "CANCELLED":
        progress.cancelled = count;
        break;
    }
  }
  return progress;
}
