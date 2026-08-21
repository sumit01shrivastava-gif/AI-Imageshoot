/**
 * Repository for `GenerationJob` (+ its `GenerationResult`s) — see
 * db/repositories/README.md and prisma/schema.prisma.
 *
 * Every function that loads a resource by a client-supplied id takes the
 * caller's `AuthContext` and scopes the query to `context.shop` — never a
 * shop value from the browser (see CLAUDE.md "Security requirements").
 * Functions scoped directly by `[shop, productId]`/`[shop, generationJobId]`
 * (list/create/update helpers below) are inherently shop-scoped by their
 * `where` clause and don't need a separate ownership check.
 */
import type { GenerationStatus, GenerationType, Prisma, ReviewStatus } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";
import type { GenerationPlan } from "../../services/generation/schema";

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
} satisfies Prisma.GenerationResultSelect;

const JOB_SELECT = {
  id: true,
  shop: true,
  productId: true,
  type: true,
  status: true,
  sourceMediaIds: true,
  plan: true,
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
  // For the review UI's "original vs. generated" comparison (mirrors
  // db/repositories/processing-job.repository.ts's JOB_SELECT) — a plain
  // reference, never a binary.
  product: { select: { title: true } },
} satisfies Prisma.GenerationJobSelect;

export type GenerationJobRow = Prisma.GenerationJobGetPayload<{ select: typeof JOB_SELECT }>;
export type GenerationResultRow = Prisma.GenerationResultGetPayload<{ select: typeof RESULT_SELECT }>;

export interface CreateGenerationJobInput {
  shop: string;
  productId: string;
  type: GenerationType;
  sourceMediaIds: string[];
  plan: GenerationPlan;
  batchId?: string;
}

/** Creates a new PENDING generation job row. Always a NEW row — unlike
 * Product Intelligence's one-profile-per-product upsert, generation
 * history is never overwritten (see prisma/schema.prisma's GenerationJob
 * model comment and docs/generation.md "Generation history"). */
export async function createGenerationJob(input: CreateGenerationJobInput): Promise<{ id: string }> {
  const row = await prisma.generationJob.create({
    data: {
      shop: input.shop,
      productId: input.productId,
      type: input.type,
      status: "PENDING",
      sourceMediaIds: input.sourceMediaIds,
      plan: input.plan as unknown as Prisma.InputJsonValue,
      identityAnchors: input.plan.productFacts.identityAnchors as unknown as Prisma.InputJsonValue,
      ...(input.batchId ? { batchId: input.batchId } : {}),
    },
    select: { id: true },
  });
  return row;
}

export async function markQueued(shop: string, id: string): Promise<void> {
  await prisma.generationJob.updateMany({ where: { id, shop }, data: { status: "QUEUED" } });
}

/** `attempt` is 1-indexed (see services/ai/types.ts's `GenerateImageInput.attempt`).
 * `startedAt` is set only once, on the first attempt — kept as "when this
 * job first started processing" for merchant-facing display; `durationMs`
 * (see markSucceeded/markFailed) tracks only the final attempt's own
 * wall-clock time, computed by the caller. Silently a no-op if `id`
 * doesn't belong to `shop` (defense in depth — the caller, job.server.ts,
 * only ever calls this with a server-derived shop). */
export async function markProcessing(shop: string, id: string, attempt: number): Promise<void> {
  const existing = await prisma.generationJob.findUnique({ where: { id }, select: { shop: true, startedAt: true } });
  if (!existing || existing.shop !== shop) return;

  await prisma.generationJob.update({
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
  providerJobId: string | undefined;
  durationMs: number;
}

export async function markSucceeded(shop: string, id: string, meta: MarkSucceededInput): Promise<void> {
  await prisma.generationJob.updateMany({
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
  providerName?: string;
  durationMs: number;
}

export async function markFailed(shop: string, id: string, meta: MarkFailedInput): Promise<void> {
  await prisma.generationJob.updateMany({
    where: { id, shop },
    data: {
      status: "FAILED",
      errorMessage: meta.message,
      completedAt: new Date(),
      ...(meta.providerName ? { providerName: meta.providerName } : {}),
      durationMs: meta.durationMs,
    },
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

export async function createResults(
  shop: string,
  generationJobId: string,
  results: CreateResultInput[],
): Promise<void> {
  await prisma.generationResult.createMany({
    data: results.map((result) => ({
      shop,
      generationJobId,
      storageKey: result.storageKey,
      url: result.url,
      width: result.width,
      height: result.height,
      format: result.format,
      providerName: result.providerName,
      providerResultId: result.providerResultId,
      metadata: (result.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    })),
  });
}

/** Loads one generation job (with its results), verifying shop ownership.
 * Returns `null` if not found for this shop. */
export async function getGenerationJob(context: AuthContext, id: string): Promise<GenerationJobRow | null> {
  const row = await prisma.generationJob.findUnique({ where: { id }, select: JOB_SELECT });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

/** All generation jobs for one product, most recent first — the
 * "Generation #1, #2, #3, ..." history (docs/generation.md "Generation
 * history"). Scoped directly by `[shop, productId]`, so this doesn't need
 * a separate ownership check the way an id-keyed lookup does. `id` (cuid
 * — monotonically increasing by creation time) is a secondary sort key
 * because `createdAt` alone has only millisecond resolution: two jobs
 * created in rapid succession (e.g. Generate then immediately Regenerate)
 * can otherwise tie and sort in an arbitrary order — see
 * db/repositories/processing-job.repository.ts's `listProcessingJobsForProduct`,
 * which documents/fixes the identical issue. */
export async function listGenerationJobsForProduct(
  context: AuthContext,
  productId: string,
): Promise<GenerationJobRow[]> {
  return prisma.generationJob.findMany({
    where: { shop: context.shop, productId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: JOB_SELECT,
  });
}

/** All generation jobs in one batch, oldest first — used by the batch
 * progress page (see services/generation/batch.server.ts). Scoped
 * directly by `[shop, batchId]`, so — like `listGenerationJobsForProduct`
 * — no separate ownership check is needed here; the caller loads the
 * owning `GenerationBatch` via `getGenerationBatch` (which does check)
 * first. See `listGenerationJobsForProduct`'s doc comment for why `id` is
 * a secondary sort key. */
export async function listGenerationJobsForBatch(shop: string, batchId: string): Promise<GenerationJobRow[]> {
  return prisma.generationJob.findMany({
    where: { shop, batchId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: JOB_SELECT,
  });
}

/** Sets a specific result's review decision. Verifies the result belongs
 * to this shop (via its job) before updating — never trusts a
 * client-supplied result id directly. Returns `false` if not found for
 * this shop (never throws — the caller maps that to a safe 404). Mirrors
 * db/repositories/processing-job.repository.ts's `setResultReviewStatus`. */
export async function setGenerationResultReviewStatus(
  context: AuthContext,
  resultId: string,
  reviewStatus: Exclude<ReviewStatus, "PENDING">,
): Promise<boolean> {
  const result = await prisma.generationResult.findUnique({
    where: { id: resultId },
    select: { id: true, shop: true },
  });
  if (!result || result.shop !== context.shop) return false;

  await prisma.generationResult.update({
    where: { id: resultId },
    data: { reviewStatus, reviewedAt: new Date() },
  });
  return true;
}

export type { GenerationStatus, GenerationType, ReviewStatus };
