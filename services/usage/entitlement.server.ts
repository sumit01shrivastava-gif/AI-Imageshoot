/**
 * Entitlement — the single place that answers "is shop X allowed to do
 * operation Y right now, and what does it cost." Built on two things:
 * `ShopSubscription` (which plan a shop is on — db/repositories/shop-
 * subscription.repository.ts) and `CreditReservation` (the reserve/
 * settle/refund credit-hold ledger — db/repositories/credit-reservation.
 * repository.ts). See docs/usage.md "Entitlement" for the full reasoning
 * and docs/billing.md "Plan catalog" for what each plan allows.
 *
 * Deliberately separate from services/usage/usage-accounting.server.ts's
 * `recordUsageEvent` — that module is an audit ledger of what already
 * happened; this module is a live gate on what's allowed to happen next,
 * checked BEFORE a job is created. The two run alongside each other for
 * the same job (both keyed by the job's own id), not in place of one
 * another.
 *
 * Covers every billable operation type (PRODUCT_ANALYSIS, IMAGE_GENERATION,
 * IMAGE_PROCESSING, STORE_VISUAL_GENERATION) — not just Creative Studio.
 * Each domain's job.server.ts calls this with its own `UsageOperationType`
 * before enqueueing, using the exact same `beforeEnqueue`-hook pattern
 * services/generation/job.server.ts already proved for Creative Studio.
 *
 * Standard lifecycle: check entitlement → reserve credits → create the
 * job → worker runs → settle on success / refund on failure. A retried
 * job never double-charges (`createReservation`'s upsert is keyed on the
 * job's own id); a failed job's hold is always given back
 * (`refundReservation`); a regeneration is a brand-new job id, so it is
 * always a new, separately-billed reservation — see docs/usage.md
 * "Credit cost rule".
 */
import type { PlanId, UsageOperationType } from "@prisma/client";
import { getEnv } from "../../lib/validation/env.server";
import type { AuthContext } from "../../lib/auth/types";
import { PLANS, DEFAULT_PLAN_ID, type PlanDefinition } from "../billing/plans";
import { getShopSubscription } from "../../db/repositories/shop-subscription.repository";
import {
  createReservation,
  settleReservation,
  refundReservation,
  getReservationForJob,
  getMonthlyCreditsUsed,
  type CreditReservationRow,
} from "../../db/repositories/credit-reservation.repository";

function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** A subscription only grants its plan while ACTIVE — PENDING (checkout
 * not yet confirmed), CANCELLED, DECLINED, EXPIRED, and FROZEN (payment
 * failure) all fall back to FREE. This is a deliberate simplification
 * (a real merchant is typically entitled through the end of an already
 * -paid period even after cancelling) documented explicitly in
 * docs/billing.md "Known limitations" rather than silently assumed. */
async function resolvePlanId(shop: string): Promise<PlanId> {
  const subscription = await getShopSubscription(shop);
  if (!subscription || subscription.status !== "ACTIVE") return DEFAULT_PLAN_ID;
  return subscription.planId;
}

/**
 * Resolves the shop's current plan definition. `CREATIVE_STUDIO_MONTHLY_CREDITS`
 * (if set) overrides the resolved plan's `monthlyCredits` — a development
 * /test convenience for exercising a specific limit without seeding a
 * `ShopSubscription` row, never a second source of truth for the plan
 * itself (allowed operations, resolution/output limits, and every other
 * field still come from the real plan).
 */
export async function getPlan(shop: string): Promise<PlanDefinition> {
  const planId = await resolvePlanId(shop);
  const plan = PLANS[planId];
  const override = getEnv().CREATIVE_STUDIO_MONTHLY_CREDITS;
  return override != null ? { ...plan, monthlyCredits: override } : plan;
}

export async function getMonthlyAllowance(shop: string): Promise<number> {
  return (await getPlan(shop)).monthlyCredits;
}

export async function canUseOperation(shop: string, operation: UsageOperationType): Promise<boolean> {
  const plan = await getPlan(shop);
  return plan.allowedOperations.includes(operation);
}

export async function getRemainingCredits(shop: string): Promise<number> {
  const plan = await getPlan(shop);
  const used = await getMonthlyCreditsUsed(shop, currentMonthStart());
  return Math.max(0, plan.monthlyCredits - used);
}

export interface EntitlementCheck {
  allowed: boolean;
  limit: number;
  used: number;
  available: number;
  required: number;
  operationType: UsageOperationType;
  /** Why `allowed` is false — absent when `allowed` is true. Lets the
   * route layer distinguish "upgrade your plan" from "wait until next
   * month / buy more credits" (Part 9's two distinct UI treatments). */
  reason?: "OPERATION_NOT_ON_PLAN" | "INSUFFICIENT_CREDITS";
}

export class InsufficientCreditsError extends Error {
  readonly check: EntitlementCheck;

  constructor(check: EntitlementCheck) {
    super(
      check.reason === "OPERATION_NOT_ON_PLAN"
        ? "This feature isn't included on your current plan."
        : `Not enough credits available (${check.available} available, ${check.required} required).`,
    );
    this.name = "InsufficientCreditsError";
    this.check = check;
  }
}

/** Checks whether `shop` may perform `operationType` at all (plan gate)
 * and, if so, whether it has enough remaining monthly allowance for a
 * request needing `requiredCredits` — read-only, does NOT reserve
 * anything (see `reserveCredits` for that). Currently-outstanding
 * RESERVED holds count against the limit already (see
 * getMonthlyCreditsUsed's doc comment), so a merchant can't submit two
 * requests that individually fit but together exceed the allowance and
 * have both silently succeed. */
export async function checkEntitlement(context: AuthContext, operationType: UsageOperationType, requiredCredits: number): Promise<EntitlementCheck> {
  const plan = await getPlan(context.shop);
  const used = await getMonthlyCreditsUsed(context.shop, currentMonthStart());
  const available = Math.max(0, plan.monthlyCredits - used);

  if (!plan.allowedOperations.includes(operationType)) {
    return { allowed: false, limit: plan.monthlyCredits, used, available, required: requiredCredits, operationType, reason: "OPERATION_NOT_ON_PLAN" };
  }

  const allowed = available >= requiredCredits;
  return { allowed, limit: plan.monthlyCredits, used, available, required: requiredCredits, operationType, reason: allowed ? undefined : "INSUFFICIENT_CREDITS" };
}

/** Creative Studio's own entry point — a thin `checkEntitlement` wrapper
 * fixed to IMAGE_GENERATION, kept so the existing call sites/tests don't
 * need to name the operation on every call. */
export async function checkGenerationEntitlement(context: AuthContext, requiredCredits: number): Promise<EntitlementCheck> {
  return checkEntitlement(context, "IMAGE_GENERATION", requiredCredits);
}

/** Idempotent — see `createReservation`'s doc comment. Always call after
 * `checkEntitlement`/`checkGenerationEntitlement` has already confirmed
 * `allowed: true` for this same request; this function itself doesn't
 * re-check the limit (check and reserve are two distinct, sequential
 * steps, not one atomic operation; a narrow race between them is an
 * accepted limitation — see docs/usage.md "Known limitations"). */
export async function reserveCredits(context: AuthContext, jobId: string, operationType: UsageOperationType, amount: number): Promise<CreditReservationRow> {
  return createReservation(context.shop, jobId, operationType, amount);
}

export async function reserveGenerationCredits(context: AuthContext, jobId: string, amount: number): Promise<CreditReservationRow> {
  return reserveCredits(context, jobId, "IMAGE_GENERATION", amount);
}

export async function settleGenerationCredits(context: AuthContext, jobId: string): Promise<void> {
  await settleReservation(context.shop, jobId);
}

export async function refundGenerationCredits(context: AuthContext, jobId: string): Promise<void> {
  await refundReservation(context.shop, jobId);
}

export async function getReservationStatus(context: AuthContext, jobId: string): Promise<CreditReservationRow | null> {
  return getReservationForJob(context.shop, jobId);
}
