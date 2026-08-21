/**
 * Repository for `StoreVisualJob` (+ its `StoreVisualResult`s and
 * `StoreVisualJobProduct` references) — see db/repositories/README.md and
 * prisma/schema.prisma. Mirrors db/repositories/generation-job.repository.ts
 * closely — see that file's doc comment for the shop-scoping convention
 * this follows throughout.
 */
import type { Prisma, ReviewStatus, StoreVisualStatus, StoreVisualType } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";
import type { StoreVisualPlan } from "../../services/store-visuals/schema";

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
} satisfies Prisma.StoreVisualResultSelect;

const JOB_SELECT = {
  id: true,
  shop: true,
  type: true,
  status: true,
  plan: true,
  errorMessage: true,
  retryCount: true,
  providerName: true,
  providerJobId: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  createdAt: true,
  updatedAt: true,
  results: { select: RESULT_SELECT, orderBy: { createdAt: "asc" } },
  products: {
    select: { productId: true, position: true, product: { select: { title: true } } },
    orderBy: { position: "asc" },
  },
} satisfies Prisma.StoreVisualJobSelect;

export type StoreVisualJobRow = Prisma.StoreVisualJobGetPayload<{ select: typeof JOB_SELECT }>;
export type StoreVisualResultRow = Prisma.StoreVisualResultGetPayload<{ select: typeof RESULT_SELECT }>;

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
  storeVisualJob: {
    select: {
      id: true,
      type: true,
      products: { select: { product: { select: { title: true } } }, orderBy: { position: "asc" }, take: 3 },
    },
  },
} satisfies Prisma.StoreVisualResultSelect;

export type StoreVisualAssetResultRow = Prisma.StoreVisualResultGetPayload<{ select: typeof ASSET_RESULT_SELECT }>;

export interface CreateStoreVisualJobInput {
  shop: string;
  type: StoreVisualType;
  plan: StoreVisualPlan;
  /** Product ids to attach as `StoreVisualJobProduct` rows, in display
   * order — never trusted directly by the caller's caller; the service
   * layer (services/store-visuals/request-store-visual.server.ts) has
   * already verified shop ownership of each before this is called. */
  productIds: string[];
}

/** Creates a new PENDING store-visual job row (+ its product references,
 * if any) — always a NEW row, mirroring GenerationJob's "history is never
 * overwritten" model exactly. */
export async function createStoreVisualJob(input: CreateStoreVisualJobInput): Promise<{ id: string }> {
  const row = await prisma.storeVisualJob.create({
    data: {
      shop: input.shop,
      type: input.type,
      status: "PENDING",
      plan: input.plan as unknown as Prisma.InputJsonValue,
      products: {
        create: input.productIds.map((productId, index) => ({ shop: input.shop, productId, position: index })),
      },
    },
    select: { id: true },
  });
  return row;
}

export async function markQueued(shop: string, id: string): Promise<void> {
  await prisma.storeVisualJob.updateMany({ where: { id, shop }, data: { status: "QUEUED" } });
}

/** Mirrors generation-job.repository.ts's `markProcessing` exactly. */
export async function markProcessing(shop: string, id: string, attempt: number): Promise<void> {
  const existing = await prisma.storeVisualJob.findUnique({ where: { id }, select: { shop: true, startedAt: true } });
  if (!existing || existing.shop !== shop) return;

  await prisma.storeVisualJob.update({
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
  await prisma.storeVisualJob.updateMany({
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
  await prisma.storeVisualJob.updateMany({
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

export async function createResults(shop: string, storeVisualJobId: string, results: CreateResultInput[]): Promise<void> {
  await prisma.storeVisualResult.createMany({
    data: results.map((result) => ({
      shop,
      storeVisualJobId,
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

/** Loads one store-visual job (with its results + product references),
 * verifying shop ownership. Returns `null` if not found for this shop. */
export async function getStoreVisualJob(context: AuthContext, id: string): Promise<StoreVisualJobRow | null> {
  const row = await prisma.storeVisualJob.findUnique({ where: { id }, select: JOB_SELECT });
  if (!row) return null;
  assertShopOwnership(context, row.shop);
  return row;
}

export interface StoreVisualJobListFilters {
  type?: StoreVisualType;
  status?: StoreVisualStatus;
}

export interface StoreVisualJobListPage {
  jobs: StoreVisualJobRow[];
  total: number;
  page: number;
  pageSize: number;
}

const STORE_VISUAL_LIST_PAGE_SIZE = 20;

/** All store-visual jobs for the shop (shop-WIDE, not per-product — a
 * store visual has no single owning product to scope by), most recent
 * first, paginated — see docs/store-visuals.md "Asset library" for why
 * this is bounded rather than an unlimited history load. `id` is a
 * secondary sort key for the same tie-breaking reason
 * listGenerationJobsForProduct documents. */
export async function listStoreVisualJobsForShop(
  context: AuthContext,
  filters: StoreVisualJobListFilters,
  page: number,
  pageSize: number = STORE_VISUAL_LIST_PAGE_SIZE,
): Promise<StoreVisualJobListPage> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const where: Prisma.StoreVisualJobWhereInput = {
    shop: context.shop,
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };

  const [jobs, total] = await prisma.$transaction([
    prisma.storeVisualJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
      select: JOB_SELECT,
    }),
    prisma.storeVisualJob.count({ where }),
  ]);

  return { jobs, total, page: safePage, pageSize };
}

export interface StoreVisualAssetFilters {
  type?: StoreVisualType;
  status?: ReviewStatus;
}

/** Shop-wide, most-recent-first StoreVisualResults — mirrors
 * db/repositories/generation-job.repository.ts's
 * `listGenerationResultsForShop`; see that function's doc comment and
 * services/assets/asset-library.server.ts for the cross-model merge
 * strategy this feeds. */
export async function listStoreVisualResultsForShop(
  shop: string,
  filters: StoreVisualAssetFilters,
  limit: number,
): Promise<StoreVisualAssetResultRow[]> {
  return prisma.storeVisualResult.findMany({
    where: {
      shop,
      ...(filters.status ? { reviewStatus: filters.status } : {}),
      ...(filters.type ? { storeVisualJob: { type: filters.type } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: ASSET_RESULT_SELECT,
  });
}

export async function countStoreVisualResultsForShop(shop: string, filters: StoreVisualAssetFilters): Promise<number> {
  return prisma.storeVisualResult.count({
    where: {
      shop,
      ...(filters.status ? { reviewStatus: filters.status } : {}),
      ...(filters.type ? { storeVisualJob: { type: filters.type } } : {}),
    },
  });
}

const PUBLISH_RESULT_SELECT = {
  id: true,
  shop: true,
  storageKey: true,
  reviewStatus: true,
  storeVisualJob: {
    select: {
      products: {
        select: { productId: true, product: { select: { shopifyProductId: true, title: true } } },
        orderBy: { position: "asc" },
      },
    },
  },
} satisfies Prisma.StoreVisualResultSelect;

export type StoreVisualPublishSourceRow = Prisma.StoreVisualResultGetPayload<{ select: typeof PUBLISH_RESULT_SELECT }>;

/** See generation-job.repository.ts's identical `getGenerationResultForPublishing`
 * — same reasoning. A store visual can feature zero, one, or several
 * products (unlike Generation/Processing's single owning product) —
 * `storeVisualJob.products` is the candidate list a merchant chooses a
 * publish target from; empty means "publishing isn't available for this
 * fully generic visual" (see services/publishing/resolve-source.server.ts). */
export async function getStoreVisualResultForPublishing(shop: string, resultId: string): Promise<StoreVisualPublishSourceRow | null> {
  const row = await prisma.storeVisualResult.findUnique({ where: { id: resultId }, select: PUBLISH_RESULT_SELECT });
  if (!row || row.shop !== shop) return null;
  return row;
}

/** Sets a specific result's review decision — mirrors
 * generation-job.repository.ts's `setGenerationResultReviewStatus`
 * exactly. */
export async function setStoreVisualResultReviewStatus(
  context: AuthContext,
  resultId: string,
  reviewStatus: Exclude<ReviewStatus, "PENDING">,
): Promise<boolean> {
  const result = await prisma.storeVisualResult.findUnique({
    where: { id: resultId },
    select: { id: true, shop: true },
  });
  if (!result || result.shop !== context.shop) return false;

  await prisma.storeVisualResult.update({
    where: { id: resultId },
    data: { reviewStatus, reviewedAt: new Date() },
  });
  return true;
}

export type { StoreVisualStatus, StoreVisualType, ReviewStatus };
