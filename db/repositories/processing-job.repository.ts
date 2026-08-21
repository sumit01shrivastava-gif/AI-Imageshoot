/**
 * Repository for `ProcessingJob` (+ its `ProcessingResult`s) — see
 * db/repositories/README.md and prisma/schema.prisma.
 *
 * Every function that loads a resource by a client-supplied id takes the
 * caller's `AuthContext` and scopes the query to `context.shop` — never a
 * shop value from the browser (see CLAUDE.md "Security requirements").
 * Functions scoped directly by `[shop, productId]`/`[shop, batchId]`
 * (list/create/update helpers below) are inherently shop-scoped by their
 * `where` clause and don't need a separate ownership check.
 */
import type { ImageOperation, Prisma, ProcessingStatus, ReviewStatus } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";
import type { ProcessingOptions } from "../../services/processing/schema";

const RESULT_SELECT = {
  id: true,
  storageKey: true,
  url: true,
  width: true,
  height: true,
  format: true,
  providerName: true,
  providerResultId: true,
  metadata: true,
  reviewStatus: true,
  reviewedAt: true,
  createdAt: true,
} satisfies Prisma.ProcessingResultSelect;

const JOB_SELECT = {
  id: true,
  shop: true,
  productId: true,
  sourceMediaId: true,
  operation: true,
  status: true,
  options: true,
  identityAnchors: true,
  errorMessage: true,
  retryCount: true,
  providerName: true,
  providerJobId: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  batchId: true,
  createdAt: true,
  updatedAt: true,
  results: { select: RESULT_SELECT, orderBy: { createdAt: "asc" } },
  // For the review UI's "original vs. processed" comparison (see
  // docs/image-processing.md "Result review UI") — a plain reference,
  // never a binary, exactly like ShopifyProductMedia's own originalUrl.
  product: { select: { title: true } },
  sourceMedia: { select: { originalUrl: true, altText: true } },
} satisfies Prisma.ProcessingJobSelect;

export type ProcessingJobRow = Prisma.ProcessingJobGetPayload<{ select: typeof JOB_SELECT }>;
export type ProcessingResultRow = Prisma.ProcessingResultGetPayload<{ select: typeof RESULT_SELECT }>;

const ASSET_RESULT_SELECT = {
  id: true,
  storageKey: true,
  url: true,
  width: true,
  height: true,
  format: true,
  reviewStatus: true,
  reviewedAt: true,
  createdAt: true,
  processingJob: { select: { id: true, operation: true, productId: true, product: { select: { title: true } } } },
} satisfies Prisma.ProcessingResultSelect;

export type ProcessingAssetResultRow = Prisma.ProcessingResultGetPayload<{ select: typeof ASSET_RESULT_SELECT }>;

export interface CreateProcessingJobInput {
  shop: string;
  productId: string;
  sourceMediaId: string;
  operation: ImageOperation;
  options: ProcessingOptions;
  identityAnchors: Record<string, unknown> | null;
  batchId?: string;
}

/** Creates a new PENDING processing job row. Always a NEW row — a
 * product's processing history is never overwritten (see
 * prisma/schema.prisma's ProcessingJob model comment). */
export async function createProcessingJob(input: CreateProcessingJobInput): Promise<{ id: string }> {
  const row = await prisma.processingJob.create({
    data: {
      shop: input.shop,
      productId: input.productId,
      sourceMediaId: input.sourceMediaId,
      operation: input.operation,
      status: "PENDING",
      options: input.options as unknown as Prisma.InputJsonValue,
      identityAnchors: (input.identityAnchors ?? undefined) as Prisma.InputJsonValue | undefined,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    },
    select: { id: true },
  });
  return row;
}

export async function markQueued(shop: string, id: string): Promise<void> {
  await prisma.processingJob.updateMany({ where: { id, shop }, data: { status: "QUEUED" } });
}

/** `attempt` is 1-indexed. `startedAt` is set only once, on the first
 * attempt — mirrors GenerationJob's markProcessing (see that file's doc
 * comment for the full reasoning). Silently a no-op if `id` doesn't
 * belong to `shop` (defense in depth). */
export async function markProcessing(shop: string, id: string, attempt: number): Promise<void> {
  const existing = await prisma.processingJob.findUnique({ where: { id }, select: { shop: true, startedAt: true } });
  if (!existing || existing.shop !== shop) return;

  await prisma.processingJob.update({
    where: { id },
    data: {
      status: "PROCESSING",
      retryCount: attempt - 1,
      ...(existing.startedAt ? {} : { startedAt: new Date() }),
    },
  });
}

export interface MarkSucceededInput {
  providerName: string;
  providerJobId?: string;
  durationMs: number;
}

export async function markSucceeded(shop: string, id: string, meta: MarkSucceededInput): Promise<void> {
  await prisma.processingJob.updateMany({
    where: { id, shop },
    data: {
      status: "SUCCEEDED",
      errorMessage: null,
      completedAt: new Date(),
      providerName: meta.providerName,
      providerJobId: meta.providerJobId,
      durationMs: meta.durationMs,
    },
  });
}

export interface MarkFailedInput {
  /** Merchant-safe summary — see CLAUDE.md "Safe error handling". */
  message: string;
  durationMs: number;
}

export async function markFailed(shop: string, id: string, meta: MarkFailedInput): Promise<void> {
  await prisma.processingJob.updateMany({
    where: { id, shop },
    data: { status: "FAILED", errorMessage: meta.message, completedAt: new Date(), durationMs: meta.durationMs },
  });
}

export interface CreateResultInput {
  storageKey: string;
  url: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  providerName: string;
  providerResultId: string | null;
  metadata: Record<string, unknown> | null;
}

export async function createResult(shop: string, processingJobId: string, result: CreateResultInput): Promise<void> {
  await prisma.processingResult.create({
    data: {
      shop,
      processingJobId,
      storageKey: result.storageKey,
      url: result.url,
      width: result.width,
      height: result.height,
      format: result.format,
      providerName: result.providerName,
      providerResultId: result.providerResultId,
      metadata: (result.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** Loads one processing job (with its results), verifying shop ownership.
 * Returns `null` if not found for this shop. */
export async function getProcessingJob(context: AuthContext, id: string): Promise<ProcessingJobRow | null> {
  const row = await prisma.processingJob.findUnique({ where: { id }, select: JOB_SELECT });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

/** All processing jobs for one product, most recent first — the
 * "Process #1, #2, #3, ..." history. `id` (cuid — monotonically
 * increasing by creation time) is a secondary sort key because
 * `createdAt` alone has only millisecond resolution: two jobs created in
 * rapid succession (e.g. two per-image actions clicked back to back, or
 * a batch's jobs created in a tight loop — see
 * services/processing/batch.server.ts) can otherwise tie and sort in an
 * arbitrary order. */
export async function listProcessingJobsForProduct(
  context: AuthContext,
  productId: string,
): Promise<ProcessingJobRow[]> {
  return prisma.processingJob.findMany({
    where: { shop: context.shop, productId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: JOB_SELECT,
  });
}

/** All processing jobs in one batch, most recently created first — used
 * by the batch progress page (see services/processing/batch.server.ts).
 * Scoped directly by `[shop, batchId]`, so — like
 * `listProcessingJobsForProduct` — no separate ownership check is needed
 * here; the caller loads the owning `ProcessingBatch` via `getBatch`
 * (which does check) first. See `listProcessingJobsForProduct`'s doc
 * comment for why `id` is a secondary sort key. */
export async function listProcessingJobsForBatch(shop: string, batchId: string): Promise<ProcessingJobRow[]> {
  return prisma.processingJob.findMany({
    where: { shop, batchId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: JOB_SELECT,
  });
}

export interface ProcessingAssetFilters {
  operation?: ImageOperation;
  status?: ReviewStatus;
}

/** Shop-wide, most-recent-first ProcessingResults — mirrors
 * db/repositories/generation-job.repository.ts's
 * `listGenerationResultsForShop`; see that function's doc comment and
 * services/assets/asset-library.server.ts for the cross-model merge
 * strategy this feeds. */
export async function listProcessingResultsForShop(
  shop: string,
  filters: ProcessingAssetFilters,
  limit: number,
): Promise<ProcessingAssetResultRow[]> {
  return prisma.processingResult.findMany({
    where: {
      shop,
      ...(filters.status ? { reviewStatus: filters.status } : {}),
      ...(filters.operation ? { processingJob: { operation: filters.operation } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: ASSET_RESULT_SELECT,
  });
}

export async function countProcessingResultsForShop(shop: string, filters: ProcessingAssetFilters): Promise<number> {
  return prisma.processingResult.count({
    where: {
      shop,
      ...(filters.status ? { reviewStatus: filters.status } : {}),
      ...(filters.operation ? { processingJob: { operation: filters.operation } } : {}),
    },
  });
}

/** Sets a specific result's review decision. Verifies the result belongs
 * to this shop (via its job) before updating — never trusts a
 * client-supplied result id directly. Returns `false` if not found for
 * this shop (never throws — the caller maps that to a safe 404). */
export async function setResultReviewStatus(
  context: AuthContext,
  resultId: string,
  reviewStatus: Exclude<ReviewStatus, "PENDING">,
): Promise<boolean> {
  const result = await prisma.processingResult.findUnique({
    where: { id: resultId },
    select: { id: true, shop: true },
  });
  if (!result || result.shop !== context.shop) return false;

  await prisma.processingResult.update({
    where: { id: resultId },
    data: { reviewStatus, reviewedAt: new Date() },
  });
  return true;
}

export type { ProcessingStatus, ImageOperation, ReviewStatus };
