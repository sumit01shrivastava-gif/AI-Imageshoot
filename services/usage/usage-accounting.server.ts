/**
 * Usage accounting — an auditable ledger of billable operations, NOT a
 * billing/credits/payment system. See docs/usage.md for the full
 * semantics; CLAUDE.md "Current phase" for why payment collection is
 * explicitly out of scope this pass.
 *
 * `recordUsageEvent` is called from each domain's own job.server.ts at
 * the terminal (SUCCEEDED/FAILED) point of a job — the exact same place
 * `markSucceeded`/`markFailed` already run, so a usage event is recorded
 * for every real attempt at billable work, success or failure, exactly
 * once (see db/repositories/usage-event.repository.ts's idempotency
 * doc comment).
 *
 * No pricing, no cost computation, no plan/quota enforcement — every
 * field here is structural accounting detail (who, what, when, how many
 * outputs, how long), left for a future billing phase to price however
 * it chooses.
 */
import type { UsageEventStatus, UsageOperationType } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import {
  recordUsageEvent as recordUsageEventRow,
  listUsageEventsForShop,
  getUsageSummaryForShop,
  type RecordUsageEventInput,
  type UsageEventListFilters,
  type UsageEventListPage,
  type UsageSummaryByType,
} from "../../db/repositories/usage-event.repository";

export type { UsageEventListFilters, UsageEventListPage, UsageSummaryByType };

/**
 * Records one billable operation's outcome. Called from worker code
 * (each domain's own job.server.ts), which already trusts `shop` from its own
 * BullMQ job payload — the same trust boundary every other repository
 * call from those files already relies on (see each job.server.ts's own
 * `AuthContext` construction). Never throws for a duplicate — see the
 * repository's idempotent upsert; a genuine database error still
 * propagates, and callers treat a usage-recording failure as
 * non-fatal-to-the-job (see each call site's `.catch` — the job's own
 * success/failure must never depend on the ledger write succeeding).
 */
export async function recordUsageEvent(input: RecordUsageEventInput): Promise<void> {
  await recordUsageEventRow(input);
}

export interface UsageOverview {
  since: Date;
  summary: UsageSummaryByType[];
  recentEvents: UsageEventListPage;
}

/** The merchant-facing Usage page's data — current-period summary plus
 * recent activity. `since` defaults to the start of the current calendar
 * month (a natural "current period" with no billing-cycle concept to
 * anchor to yet — see docs/usage.md "Period semantics"). Tenant-scoped
 * via `context.shop`, never a client-supplied shop. */
export async function getUsageOverview(context: AuthContext, page = 1): Promise<UsageOverview> {
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [summary, recentEvents] = await Promise.all([
    getUsageSummaryForShop(context.shop, since),
    listUsageEventsForShop(context.shop, {}, page),
  ]);

  return { since, summary, recentEvents };
}

export const USAGE_OPERATION_TYPES: UsageOperationType[] = [
  "PRODUCT_ANALYSIS",
  "IMAGE_GENERATION",
  "IMAGE_PROCESSING",
  "STORE_VISUAL_GENERATION",
];

export type { UsageOperationType, UsageEventStatus };
