/**
 * Unit tests: services/usage/entitlement.server.ts — the reserve/settle/
 * refund credit lifecycle (Part 9), with the repository mocked so the
 * check/allow/deny logic is exercised deterministically. The real
 * Postgres-backed reserve/settle/refund/idempotency behavior is covered
 * by tests/integration/creative-studio/session.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createReservation = vi.fn();
const settleReservation = vi.fn();
const refundReservation = vi.fn();
const getReservationForJob = vi.fn();
const getMonthlyCreditsUsed = vi.fn();

vi.mock("../../../db/repositories/credit-reservation.repository", () => ({
  createReservation: (...args: unknown[]) => createReservation(...args),
  settleReservation: (...args: unknown[]) => settleReservation(...args),
  refundReservation: (...args: unknown[]) => refundReservation(...args),
  getReservationForJob: (...args: unknown[]) => getReservationForJob(...args),
  getMonthlyCreditsUsed: (...args: unknown[]) => getMonthlyCreditsUsed(...args),
}));

import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

const CONTEXT = { shop: "entitlement-test.myshopify.com", sessionId: "s1", isOnline: false };

beforeEach(() => {
  createReservation.mockReset().mockResolvedValue({ id: "res-1", jobId: "job-1", amount: 1, status: "RESERVED", createdAt: new Date(), resolvedAt: null });
  settleReservation.mockReset().mockResolvedValue(undefined);
  refundReservation.mockReset().mockResolvedValue(undefined);
  getReservationForJob.mockReset().mockResolvedValue(null);
  getMonthlyCreditsUsed.mockReset().mockResolvedValue(0);
  delete process.env.CREATIVE_STUDIO_MONTHLY_CREDITS;
  resetEnvCacheForTests();
});

afterEach(() => {
  delete process.env.CREATIVE_STUDIO_MONTHLY_CREDITS;
  resetEnvCacheForTests();
});

describe("checkGenerationEntitlement", () => {
  it("allows a request within the default 200-credit monthly allowance", async () => {
    getMonthlyCreditsUsed.mockResolvedValue(50);
    const { checkGenerationEntitlement, resetConfiguredEntitlementProviderForTests } = await import(
      "../../../services/usage/entitlement.server"
    );
    resetConfiguredEntitlementProviderForTests();

    const check = await checkGenerationEntitlement(CONTEXT, 3);
    expect(check).toEqual({ allowed: true, limit: 200, used: 50, available: 150, required: 3 });
  });

  it("denies a request that would exceed the remaining allowance", async () => {
    getMonthlyCreditsUsed.mockResolvedValue(199);
    const { checkGenerationEntitlement, resetConfiguredEntitlementProviderForTests } = await import(
      "../../../services/usage/entitlement.server"
    );
    resetConfiguredEntitlementProviderForTests();

    const check = await checkGenerationEntitlement(CONTEXT, 2);
    expect(check.allowed).toBe(false);
    expect(check.available).toBe(1);
  });

  it("honors CREATIVE_STUDIO_MONTHLY_CREDITS as the configured limit", async () => {
    process.env.CREATIVE_STUDIO_MONTHLY_CREDITS = "10";
    resetEnvCacheForTests();
    getMonthlyCreditsUsed.mockResolvedValue(0);

    const { checkGenerationEntitlement, resetConfiguredEntitlementProviderForTests } = await import(
      "../../../services/usage/entitlement.server"
    );
    resetConfiguredEntitlementProviderForTests();

    const check = await checkGenerationEntitlement(CONTEXT, 1);
    expect(check.limit).toBe(10);
  });

  it("never reports a negative available balance when usage has somehow exceeded the limit", async () => {
    getMonthlyCreditsUsed.mockResolvedValue(500);
    const { checkGenerationEntitlement, resetConfiguredEntitlementProviderForTests } = await import(
      "../../../services/usage/entitlement.server"
    );
    resetConfiguredEntitlementProviderForTests();

    const check = await checkGenerationEntitlement(CONTEXT, 1);
    expect(check.available).toBe(0);
    expect(check.allowed).toBe(false);
  });
});

describe("reserve/settle/refund", () => {
  it("reserveGenerationCredits delegates to the repository's idempotent upsert", async () => {
    const { reserveGenerationCredits } = await import("../../../services/usage/entitlement.server");
    await reserveGenerationCredits(CONTEXT, "job-1", 2);
    expect(createReservation).toHaveBeenCalledWith(CONTEXT.shop, "job-1", 2);
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
    const check = { allowed: false, limit: 10, used: 10, available: 0, required: 2 };
    const error = new InsufficientCreditsError(check);
    expect(error.check).toBe(check);
    expect(error.message).toMatch(/0 available/);
    expect(error.message).toMatch(/2 required/);
  });
});
