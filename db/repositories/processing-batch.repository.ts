/**
 * Repository for `ProcessingBatch` — see db/repositories/README.md and
 * prisma/schema.prisma's model comment (progress is computed, not
 * persisted — see `getBatchProgress` below).
 */
import type { ImageOperation } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";

export interface CreateBatchInput {
  shop: string;
  operation: ImageOperation;
  sourceSelectionId?: string;
}

export async function createBatch(input: CreateBatchInput): Promise<{ id: string }> {
  return prisma.processingBatch.create({
    data: {
      shop: input.shop,
      operation: input.operation,
      sourceSelectionId: input.sourceSelectionId,
    },
    select: { id: true },
  });
}

export interface BatchRow {
  id: string;
  shop: string;
  operation: ImageOperation;
  createdAt: Date;
}

/** Loads one batch's own row (not its jobs — see `getBatchProgress`/
 * db/repositories/processing-job.repository.ts's `listProcessingJobsForProduct`
 * for job-level detail), verifying shop ownership. */
export async function getBatch(context: AuthContext, id: string): Promise<BatchRow | null> {
  const row = await prisma.processingBatch.findUnique({
    where: { id },
    select: { id: true, shop: true, operation: true, createdAt: true },
  });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

export interface BatchProgress {
  total: number;
  pending: number;
  queued: number;
  processing: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

const EMPTY_PROGRESS: BatchProgress = {
  total: 0,
  pending: 0,
  queued: 0,
  processing: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
};

/**
 * Computed at read time via a `groupBy` over `ProcessingJob.status`
 * scoped to this batch — never a persisted counter on `ProcessingBatch`
 * itself, so it can never drift from the jobs it's summarizing (same
 * "derive, don't duplicate" principle as
 * services/intelligence/stale.ts's staleness check). Ownership isn't
 * separately checked here — callers first load the batch via `getBatch`
 * (which does check), then call this with the id it already verified.
 */
export async function getBatchProgress(batchId: string): Promise<BatchProgress> {
  const groups = await prisma.processingJob.groupBy({
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
