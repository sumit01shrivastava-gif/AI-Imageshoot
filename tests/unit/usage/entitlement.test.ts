/**
 * Unit tests: services/usage/entitlement.server.ts — plan resolution
 * (Part 6) and the reserve/settle/refund credit lifecycle (Part 5), with
 * both repositories mocked so the check/allow/deny logic is exercised
 * deterministically. The real Postgres-backed reserve/settle/refund/
 * idempotency behavior is covered by
 * tests/integration/creative-studio/session.test.ts and
 * tests/integration/usage/.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createReservation = vi.fn();
const settleReservation = vi.fn();
const refundReservation = vi.fn();
const getReservationForJob = vi.fn();
const getMonthlyCreditsUsed = vi.fn();
const getShopSubscription = vi.fn();

vi.mock("../../../db/repositories/credit-reservation.repository", () => ({
  createReservation: (...args: unknown[]) => createReservation(...args),
  settleReservation: (...args: unknown[]) => settleReservation(...args),
  refundReservation: (...args: unknown[]) => refundReservation(...args),
  getReservationForJob: (...args: unknown[]) => getReservationForJob(...args),
  getMonthlyCreditsUsed: (...args: unknown[]) => getMonthlyCreditsUsed(...args),
}));

vi.mock("../../../db/repositories/shop-subscription.repository", () => ({
  getShopSubscription: (...args: unknown[]) => getShopSubscription(...args),
}));

import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

const CONTEXT = { shop: "entitlement-test.myshopify.com", sessionId: "s1", isOnline: false };

beforeEach(() => {
  createReservation.mockReset().mockResolvedValue({
    id: "res-1",
    jobId: "job-1",
    operationType: "IMAGE_GENERATION",
    amount: 1,
    status: "RESERVED",
    createdAt: new Date(),
    resolvedAt: null,
  });
  settleReservation.mockReset().mockResolvedValue(undefined);
  refundReservation.mockReset().mockResolvedValue(undefined);
  getReservationForJob.mockReset().mockResolvedValue(null);
  getMonthlyCreditsUsed.mockReset().mockResolvedValue(0);
  getShopSubscription.mockReset().mockResolvedValue(null); // no row → FREE plan
  delete process.env.CREATIVE_STUDIO_MONTHLY_CREDITS;
  resetEnvCacheForTests();
});

afterEach(() => {
  delete process.env.CREATIVE_STUDIO_MONTHLY_CREDITS;
  resetEnvCacheForTests();
});

describe("getPlan", () => {
  it("resolves to FREE when the shop has no ShopSubscription row", async () => {
    const { getPlan } = await import("../../../services/usage/entitlement.server");
    const plan = await getPlan(CONTEXT.shop);
    expect(plan.id).toBe("FREE");
    expect(plan.monthlyCredits).toBe(40);
  });

  it("resolves to the shop's real plan when ACTIVE", async () => {
    getShopSubscription.mockResolvedValue({ planId: "PRO", status: "ACTIVE" });
    const { getPlan } = await import("../../../services/usage/entitlement.server");
    const plan = await getPlan(CONTEXT.shop);
    expect(plan.id).toBe("PRO");
    expect(plan.monthlyCredits).toBe(800);
  });

  it("falls back to FREE when the subscription isn't ACTIVE (e.g. CANCELLED)", async () => {
    getShopSubscription.mockResolvedValue({ planId: "PRO", status: "CANCELLED" });
    const { getPlan } = await import("../../../services/usage/entitlement.server");
    const plan = await getPlan(CONTEXT.shop);
    expect(plan.id).toBe("FREE");
  });

  it("honors CREATIVE_STUDIO_MONTHLY_CREDITS as a monthlyCredits override on top of the resolved plan", async () => {
    process.env.CREATIVE_STUDIO_MONTHLY_CREDITS = "10";
    resetEnvCacheForTests();
    const { getPlan } = await import("../../../services/usage/entitlement.server");
    const plan = await getPlan(CONTEXT.shop);
    expect(plan.monthlyCredits).toBe(10);
    // Every other plan field is untouched by the override.
    expect(plan.id).toBe("FREE");
  });
});

describe("canUseOperation", () => {
  it("allows an operation included in the resolved plan", async () => {
    const { canUseOperation } = await import("../../../services/usage/entitlement.server");
    expect(await canUseOperation(CONTEXT.shop, "IMAGE_GENERATION")).toBe(true);
  });

  it("blocks an operation not included in the resolved plan (FREE has no STORE_VISUAL_GENERATION)", async () => {
    const { canUseOperation } = await import("../../../services/usage/entitlement.server");
    expect(await canUseOperation(CONTEXT.shop, "STORE_VISUAL_GENERATION")).toBe(false);
  });
});

describe("checkGenerationEntitlement", () => {
  it("allows a request within the default 40-credit FREE monthly allowance", async () => {
    getMonthlyCreditsUsed.mockResolvedValue(10);
    const { checkGenerationEntitlement } = await import("../../../services/usage/entitlement.server");

    const check = await checkGenerationEntitlement(CONTEXT, 3);
    expect(check).toEqual({ allowed: true, limit: 40, used: 10, available: 30, required: 3, operationType: "IMAGE_GENERATION" });
  });

  it("denies a request that would exceed the remaining allowance", async () => {
    getMonthlyCreditsUsed.mockResolvedValue(39);
    const { checkGenerationEntitlement } = await import("../../../services/usage/entitlement.server");

    const check = await checkGenerationEntitlement(CONTEXT, 2);
    expect(check.allowed).toBe(false);
    expect(check.available).toBe(1);
    expect(check.reason).toBe("INSUFFICIENT_CREDITS");
  });

  it("honors CREATIVE_STUDIO_MONTHLY_CREDITS as the configured limit", async () => {
    process.env.CREATIVE_STUDIO_MONTHLY_CREDITS = "10";
    resetEnvCacheForTests();
    getMonthlyCreditsUsed.mockResolvedValue(0);

    const { checkGenerationEntitlement } = await import("../../../services/usage/entitlement.server");

    const check = await checkGenerationEntitlement(CONTEXT, 1);
    expect(check.limit).toBe(10);
  });

  it("never reports a negative available balance when usage has somehow exceeded the limit", async () => {
    getMonthlyCreditsUsed.mockResolvedValue(500);
    const { checkGenerationEntitlement } = await import("../../../services/usage/entitlement.server");

    const check = await checkGenerationEntitlement(CONTEXT, 1);
    expect(check.available).toBe(0);
    expect(check.allowed).toBe(false);
  });

  it("reports OPERATION_NOT_ON_PLAN, not INSUFFICIENT_CREDITS, when the plan doesn't include the operation at all", async () => {
    getMonthlyCreditsUsed.mockResolvedValue(0);
    const { checkEntitlement } = await import("../../../services/usage/entitlement.server");

    const check = await checkEntitlement(CONTEXT, "STORE_VISUAL_GENERATION", 1);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("OPERATION_NOT_ON_PLAN");
  });
});

describe("reserve/settle/refund", () => {
  it("reserveGenerationCredits delegates to the repository's idempotent upsert with operationType IMAGE_GENERATION", async () => {
    const { reserveGenerationCredits } = await import("../../../services/usage/entitlement.server");
    await reserveGenerationCredits(CONTEXT, "job-1", 2);
    expect(createReservation).toHaveBeenCalledWith(CONTEXT.shop, "job-1", "IMAGE_GENERATION", 2);
  });

  it("reserveCredits delegates with the caller-supplied operationType", async () => {
    const { reserveCredits } = await import("../../../services/usage/entitlement.server");
    await reserveCredits(CONTEXT, "job-2", "IMAGE_PROCESSING", 1);
    expect(createReservation).toHaveBeenCalledWith(CONTEXT.shop, "job-2", "IMAGE_PROCESSING", 1);
  });

  it("settleGenerationCredits delegates to the repository's conditional update", async () => {
    const { settleGenerationCredits } = await import("../../../services/usage/entitlement.server");
    await settleGenerationCredits(CONTEXT, "job-1");
    expect(settleReservation).toHaveBeenCalledWith(CONTEXT.shop, "job-1");
  });

  it("refundGenerationCredits delegates to the repository's conditional update", async () => {
    const { refundGenerationCredits } = await import("../../../services/usage/entitlement.server");
    await refundGenerationCredits(CONTEXT, "job-1");
    expect(refundReservation).toHaveBeenCalledWith(CONTEXT.shop, "job-1");
  });
});

describe("InsufficientCreditsError", () => {
  it("carries the failing check for the caller to render a specific message", async () => {
    const { InsufficientCreditsError } = await import("../../../services/usage/entitlement.server");
    const check = {
      allowed: false as const,
      limit: 10,
      used: 10,
      available: 0,
      required: 2,
      operationType: "IMAGE_GENERATION" as const,
      reason: "INSUFFICIENT_CREDITS" as const,
    };
    const error = new InsufficientCreditsError(check);
    expect(error.check).toBe(check);
    expect(error.message).toMatch(/0 available/);
    expect(error.message).toMatch(/2 required/);
  });

  it("carries a distinct message for a plan-gated (not credit-exhausted) denial", async () => {
    const { InsufficientCreditsError } = await import("../../../services/usage/entitlement.server");
    const check = {
      allowed: false as const,
      limit: 40,
      used: 0,
      available: 40,
      required: 2,
      operationType: "STORE_VISUAL_GENERATION" as const,
      reason: "OPERATION_NOT_ON_PLAN" as const,
    };
    const error = new InsufficientCreditsError(check);
    expect(error.message).toMatch(/plan/i);
  });
});
