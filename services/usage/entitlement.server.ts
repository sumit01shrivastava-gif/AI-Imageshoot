/**
 * Generation credit entitlement — the reserve/settle/refund lifecycle
 * Part 9 asks for, layered on top of `CreditReservation`
 * (db/repositories/credit-reservation.repository.ts). See
 * docs/creative-studio.md "Credit lifecycle" for the full reasoning.
 *
 * Deliberately separate from services/usage/usage-accounting.server.ts's
 * `recordUsageEvent` — that module is an audit ledger of what already
 * happened; this module is a live gate on what's allowed to happen next,
 * checked BEFORE a job is created. The two run alongside each other for
 * the same job (both keyed by the job's own id), not in place of one
 * another.
 *
 * Only the Creative Studio's own generation path calls this — every
 * pre-existing generationType (PRODUCT_CLEANUP, LIFESTYLE, ...) is
 * completely unaffected; retrofitting credit enforcement onto those
 * would be scope creep beyond what this pass's instructions ask for
 * ("make the Creative Studio generation path credit-aware," not every
 * generation path).
 *
 * Intended lifecycle (enforced by
 * services/creative-studio/session.server.ts's `requestCreativeGeneration`,
 * never scattered across routes — see Part 9): validate entitlement →
 * reserve credits → create the job → worker generates → settle on
 * success / refund on failure.
 */
import { getEnv } from "../../lib/validation/env.server";
import type { AuthContext } from "../../lib/auth/types";
import {
  createReservation,
  settleReservation,
  refundReservation,
  getReservationForJob,
  getMonthlyCreditsUsed,
  type CreditReservationRow,
} from "../../db/repositories/credit-reservation.repository";

export interface EntitlementProvider {
  readonly name: string;
  getMonthlyAllowance(shop: string): Promise<number>;
}

const DEFAULT_MONTHLY_CREDITS = 200;

/**
 * The only `EntitlementProvider` implementation today — no
 * subscription/billing plan exists yet (explicitly out of scope this
 * pass; see CLAUDE.md), so every shop gets one clearly-labeled,
 * generous, isolated development allowance rather than being blocked
 * outright. "Development" is in the name deliberately — never presented
 * to a merchant as a real plan (the UI labels this "development credit
 * allowance," never invented currency/pricing — see Part 7). A future
 * billing phase replaces this with a real per-plan `EntitlementProvider`
 * behind the exact same interface; nothing calling
 * `getConfiguredEntitlementProvider()` needs to change.
 */
export class DevelopmentEntitlementProvider implements EntitlementProvider {
  readonly name = "development";

  // `shop` is part of the `EntitlementProvider` interface (a future
  // per-plan implementation needs it to look up that shop's actual plan)
  // but this development default is the same flat allowance for every
  // shop, so it goes unused here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getMonthlyAllowance(shop: string): Promise<number> {
    return getEnv().CREATIVE_STUDIO_MONTHLY_CREDITS ?? DEFAULT_MONTHLY_CREDITS;
  }
}

let cachedProvider: EntitlementProvider | undefined;

export function getConfiguredEntitlementProvider(): EntitlementProvider {
  if (!cachedProvider) cachedProvider = new DevelopmentEntitlementProvider();
  return cachedProvider;
}

/** Test-only: forces a fresh instance so a test's env override
 * (CREATIVE_STUDIO_MONTHLY_CREDITS) is actually picked up. */
export function resetConfiguredEntitlementProviderForTests(): void {
  cachedProvider = undefined;
}

export interface EntitlementCheck {
  allowed: boolean;
  limit: number;
  used: number;
  available: number;
  required: number;
}

function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Checks whether `shop` has enough remaining monthly allowance for a
 * request needing `requiredCredits` — read-only, does NOT reserve
 * anything (see `reserveGenerationCredits` for that). Currently-
 * outstanding RESERVED holds count against the limit already (see
 * getMonthlyCreditsUsed's doc comment), so a merchant can't submit two
 * requests that individually fit but together exceed the allowance and
 * have both silently succeed. */
export async function checkGenerationEntitlement(context: AuthContext, requiredCredits: number): Promise<EntitlementCheck> {
  const provider = getConfiguredEntitlementProvider();
  const limit = await provider.getMonthlyAllowance(context.shop);
  const used = await getMonthlyCreditsUsed(context.shop, currentMonthStart());
  const available = Math.max(0, limit - used);
  return { allowed: available >= requiredCredits, limit, used, available, required: requiredCredits };
}

export class InsufficientCreditsError extends Error {
  readonly check: EntitlementCheck;

  constructor(check: EntitlementCheck) {
    super(`Not enough credits available (${check.available} available, ${check.required} required).`);
    this.name = "InsufficientCreditsError";
    this.check = check;
  }
}

/** Idempotent — see `createReservation`'s doc comment. Always call after
 * `checkGenerationEntitlement` has already confirmed `allowed: true` for
 * this same request; this function itself doesn't re-check the limit
 * (see module doc comment — check and reserve are two distinct,
 * sequential steps, not one atomic operation; a narrow race between them
 * is an accepted limitation of the development entitlement provider —
 * see docs/creative-studio.md "Known limitations"). */
export async function reserveGenerationCredits(context: AuthContext, jobId: string, amount: number): Promise<CreditReservationRow> {
  return createReservation(context.shop, jobId, amount);
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
