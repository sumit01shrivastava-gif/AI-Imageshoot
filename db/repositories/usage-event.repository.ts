/**
 * Repository for `UsageEvent` — see prisma/schema.prisma's model comment
 * and docs/usage.md. Shop-scoped throughout; `listUsageEventsForShop`/
 * `getUsageSummaryForShop` are inherently shop-scoped by their `where`
 * clause (see db/repositories/README.md's "no separate ownership check
 * needed" convention for list-by-shop functions).
 */
import type { Prisma, UsageEventStatus, UsageOperationType } from "@prisma/client";
import prisma from "../client.server";

export interface RecordUsageEventInput {
  shop: string;
  operationType: UsageOperationType;
  status: UsageEventStatus;
  /** The originating domain job's own id — see the Prisma model comment
   * for why this is a soft reference, not a foreign key. */
  jobId: string;
  providerName?: string | null;
  unitsConsumed?: number;
  outputCount?: number;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Records one usage event, idempotently — `idempotencyKey` is built as
 * `"{operationType}:{jobId}"` and is the table's unique constraint, so
 * calling this twice for the same logical operation (a redelivered
 * BullMQ completion, a duplicate terminal-state transition) is a safe
 * no-op the second time, never a double charge. See docs/usage.md
 * "Idempotency semantics".
 *
 * Uses `upsert` rather than `create` + catching a unique-constraint
 * error specifically so a legitimate STATUS CHANGE for the same
 * operation (e.g. a job that appeared to fail, but a redelivered
 * "succeeded" event arrives afterward for the same `jobId`) still
 * updates the row rather than being silently dropped — the exact same
 * id always means the exact same logical operation, so the LATEST
 * terminal state recorded for it is authoritative.
 */
export async function recordUsageEvent(input: RecordUsageEventInput): Promise<{ id: string; wasNew: boolean }> {
  const idempotencyKey = `${input.operationType}:${input.jobId}`;

  const existing = await prisma.usageEvent.findUnique({ where: { idempotencyKey }, select: { id: true } });

  const row = await prisma.usageEvent.upsert({
    where: { idempotencyKey },
    create: {
      shop: input.shop,
      operationType: input.operationType,
      status: input.status,
      jobId: input.jobId,
      idempotencyKey,
      providerName: input.providerName ?? null,
      unitsConsumed: input.unitsConsumed ?? 1,
      outputCount: input.outputCount ?? 0,
      durationMs: input.durationMs ?? null,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    update: {
      status: input.status,
      providerName: input.providerName ?? null,
      unitsConsumed: input.unitsConsumed ?? 1,
      outputCount: input.outputCount ?? 0,
      durationMs: input.durationMs ?? null,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    select: { id: true },
  });

  return { id: row.id, wasNew: !existing };
}

export interface UsageEventListFilters {
  operationType?: UsageOperationType;
  status?: UsageEventStatus;
  /** Inclusive lower bound — used for "this billing period" queries. */
  since?: Date;
}

export interface UsageEventRow {
  id: string;
  operationType: UsageOperationType;
  status: UsageEventStatus;
  jobId: string;
  providerName: string | null;
  unitsConsumed: number;
  outputCount: number;
  durationMs: number | null;
  createdAt: Date;
}

const EVENT_SELECT = {
  id: true,
  operationType: true,
  status: true,
  jobId: true,
  providerName: true,
  unitsConsumed: true,
  outputCount: true,
  durationMs: true,
  createdAt: true,
} satisfies Prisma.UsageEventSelect;

export interface UsageEventListPage {
  events: UsageEventRow[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 25;

function buildWhere(shop: string, filters: UsageEventListFilters): Prisma.UsageEventWhereInput {
  return {
    shop,
    ...(filters.operationType ? { operationType: filters.operationType } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
  };
}

/** Most-recent-first, paginated — mirrors every other shop-wide listing
 * in this codebase (e.g. services/store-visuals'
 * `listStoreVisualJobsForShop`). */
export async function listUsageEventsForShop(
  shop: string,
  filters: UsageEventListFilters,
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<UsageEventListPage> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const where = buildWhere(shop, filters);

  const [events, total] = await prisma.$transaction([
    prisma.usageEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
      select: EVENT_SELECT,
    }),
    prisma.usageEvent.count({ where }),
  ]);

  return { events, total, page: safePage, pageSize };
}

export interface UsageSummaryByType {
  operationType: UsageOperationType;
  succeededCount: number;
  failedCount: number;
  totalOutputCount: number;
}

/** Aggregated counts per operation type for the given window — the
 * merchant-facing Usage page's summary tiles. A `groupBy` computed at
 * read time, never a persisted counter — same convention every batch
 * progress computation in this codebase already uses (e.g.
 * `getGenerationBatchProgress`). */
export async function getUsageSummaryForShop(shop: string, since: Date): Promise<UsageSummaryByType[]> {
  const rows = await prisma.usageEvent.groupBy({
    by: ["operationType", "status"],
    where: { shop, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { outputCount: true },
  });

  const byType = new Map<UsageOperationType, UsageSummaryByType>();
  for (const row of rows) {
    const existing = byType.get(row.operationType) ?? {
      operationType: row.operationType,
      succeededCount: 0,
      failedCount: 0,
      totalOutputCount: 0,
    };
    if (row.status === "SUCCEEDED") {
      existing.succeededCount += row._count._all;
      existing.totalOutputCount += row._sum.outputCount ?? 0;
    } else {
      existing.failedCount += row._count._all;
    }
    byType.set(row.operationType, existing);
  }

  return Array.from(byType.values());
}
