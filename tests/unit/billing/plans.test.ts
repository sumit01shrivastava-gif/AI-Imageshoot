/**
 * Unit tests: services/billing/plans.ts — the plan catalog's internal
 * consistency (Part 6). No I/O; a pure data-shape sanity check.
 */
import { describe, expect, it } from "vitest";
import { PLANS, PLAN_ORDER, DEFAULT_PLAN_ID, getPlanDefinition } from "../../../services/billing/plans";

describe("PLANS catalog", () => {
  it("defines exactly FREE/STARTER/PRO/BUSINESS", () => {
    expect(Object.keys(PLANS).sort()).toEqual(["BUSINESS", "FREE", "PRO", "STARTER"]);
  });

  it("defaults to FREE", () => {
    expect(DEFAULT_PLAN_ID).toBe("FREE");
  });

  it("FREE is genuinely free", () => {
    expect(PLANS.FREE.priceUsd).toBe(0);
  });

  it("every paid plan costs more than the one below it, in PLAN_ORDER", () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = PLANS[PLAN_ORDER[i - 1]];
      const higher = PLANS[PLAN_ORDER[i]];
      expect(higher.priceUsd).toBeGreaterThanOrEqual(lower.priceUsd);
      expect(higher.monthlyCredits).toBeGreaterThan(lower.monthlyCredits);
    }
  });

  it("every plan allows PRODUCT_ANALYSIS and IMAGE_GENERATION at minimum", () => {
    for (const plan of Object.values(PLANS)) {
      expect(plan.allowedOperations).toContain("PRODUCT_ANALYSIS");
      expect(plan.allowedOperations).toContain("IMAGE_GENERATION");
    }
  });

  it("only FREE excludes STORE_VISUAL_GENERATION", () => {
    expect(PLANS.FREE.allowedOperations).not.toContain("STORE_VISUAL_GENERATION");
    expect(PLANS.STARTER.allowedOperations).toContain("STORE_VISUAL_GENERATION");
    expect(PLANS.PRO.allowedOperations).toContain("STORE_VISUAL_GENERATION");
    expect(PLANS.BUSINESS.allowedOperations).toContain("STORE_VISUAL_GENERATION");
  });

  it("getPlanDefinition returns the exact same object as the PLANS table", () => {
    expect(getPlanDefinition("PRO")).toBe(PLANS.PRO);
  });

  it("PLAN_ORDER contains every PlanId exactly once", () => {
    expect([...PLAN_ORDER].sort()).toEqual(Object.keys(PLANS).sort());
  });
});
