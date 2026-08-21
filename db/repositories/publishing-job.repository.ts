/**
 * Repository for `PublishingJob` — see prisma/schema.prisma's model
 * comment and docs/publishing.md. Mirrors
 * db/repositories/processing-job.repository.ts's shape (create/
 * markProcessing/markSucceeded/markFailed/get/list), the same
 * established pattern every job-producing domain in this codebase
 * follows.
 */
import type { Prisma, PublishingSourceType, PublishingStatus } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";

const JOB_SELECT = {
  id: true,
  shop: true,
  sourceType: true,
  sourceResultId: true,
  targetProductId: true,
  status: true,
  shopifyMediaId: true,
  errorMessage: true,
  retryCount: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  createdAt: true,
  updatedAt: true,
  targetProduct: { select: { title: true } },
} satisfies Prisma.PublishingJobSelect;

export type PublishingJobRow = Prisma.PublishingJobGetPayload<{ select: typeof JOB_SELECT }>;

export interface CreatePublishingJobInput {
  shop: string;
  sourceType: PublishingSourceType;
  sourceResultId: string;
  targetProductId: string;
}

/** Creates a new PENDING publishing job row. Always a new row — a
 * re-publish attempt after a FAILED job creates another one, never
 * overwrites the prior attempt's history (same convention as every
 * other job model in this schema). Double-publish prevention (don't
 * create a second job while one is already in flight or already
 * succeeded for the same source) is a SERVICE-layer concern (see
 * services/publishing/request-publish.server.ts), not enforced here —
 * this function trusts its caller already checked. */
export async function createPublishingJob(input: CreatePublishingJobInput): Promise<{ id: string }> {
  return prisma.publishingJob.create({
    data: {
      shop: input.shop,
      sourceType: input.sourceType,
      sourceResultId: input.sourceResultId,
      targetProductId: input.targetProductId,
      status: "PENDING",
    },
    select: { id: true },
  });
}

export async function markQueued(shop: string, id: string): Promise<void> {
  await prisma.publishingJob.updateMany({ where: { id, shop }, data: { status: "QUEUED" } });
}

export async function markProcessing(shop: string, id: string, attempt: number): Promise<void> {
  const existing = await prisma.publishingJob.findUnique({ where: { id }, select: { shop: true, startedAt: true } });
  if (!existing || existing.shop !== shop) return;

  await prisma.publishingJob.update({
    where: { id },
    data: {
      status: "PROCESSING",
      retryCount: attempt - 1,
      ...(existing.startedAt ? {} : { startedAt: new Date() }),
    },
  });
}

export interface MarkSucceededInput {
  shopifyMediaId: string;
  durationMs: number;
}

export async function markSucceeded(shop: string, id: string, meta: MarkSucceededInput): Promise<void> {
  await prisma.publishingJob.updateMany({
    where: { id, shop },
    data: {
      status: "SUCCEEDED",
      errorMessage: null,
      shopifyMediaId: meta.shopifyMediaId,
      completedAt: new Date(),
      durationMs: meta.durationMs,
    },
  });
}

export interface MarkFailedInput {
  /** Merchant-safe summary — see CLAUDE.md "Safe error handling". Never
   * a raw Shopify API error body. */
  message: string;
  durationMs: number;
}

export async function markFailed(shop: string, id: string, meta: MarkFailedInput): Promise<void> {
  await prisma.publishingJob.updateMany({
    where: { id, shop },
    data: {
      status: "FAILED",
      errorMessage: meta.message,
      completedAt: new Date(),
      durationMs: meta.durationMs,
    },
  });
}

export async function getPublishingJob(context: AuthContext, id: string): Promise<PublishingJobRow | null> {
  const row = await prisma.publishingJob.findUnique({ where: { id }, select: JOB_SELECT });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

/** The most recent publishing job for one source result — used both to
 * enforce "don't double-publish" (services/publishing/request-publish.server.ts)
 * and to show "Ready / Publishing / Published / Failed" state on a
 * result's review card. Null if this source has never been published. */
export async function getLatestPublishingJobForSource(
  shop: string,
  sourceType: PublishingSourceType,
  sourceResultId: string,
): Promise<PublishingJobRow | null> {
  return prisma.publishingJob.findFirst({
    where: { shop, sourceType, sourceResultId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: JOB_SELECT,
  });
}

export interface PublishingJobListFilters {
  status?: PublishingStatus;
}

export interface PublishingJobListPage {
  jobs: PublishingJobRow[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 20;

/** Shop-wide, most-recent-first publish history — mirrors
 * services/store-visuals' `listStoreVisualJobsForShop` (the first
 * shop-wide, not-per-product paginated job listing in this codebase;
 * publishing has the same "many possible target products, no single
 * owning one" shape). */
export async function listPublishingHistoryForShop(
  shop: string,
  filters: PublishingJobListFilters,
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<PublishingJobListPage> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const where: Prisma.PublishingJobWhereInput = {
    shop,
    ...(filters.status ? { status: filters.status } : {}),
  };

  const [jobs, total] = await prisma.$transaction([
    prisma.publishingJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
      select: JOB_SELECT,
    }),
    prisma.publishingJob.count({ where }),
  ]);

  return { jobs, total, page: safePage, pageSize };
}
