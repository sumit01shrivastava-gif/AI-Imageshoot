/**
 * Unit tests: services/usage/credit-costs.ts — the documented credit
 * cost rule (Part 5): `perOutputCost(operationType, mode) × max(1,
 * outputCount)`, a flat per-operation rate for PRODUCT_ANALYSIS.
 */
import { describe, expect, it } from "vitest";
import { getCreditCost } from "../../../services/usage/credit-costs";

describe("getCreditCost", () => {
  it("charges PRODUCT_ANALYSIS a flat rate regardless of outputCount", () => {
    expect(getCreditCost({ operationType: "PRODUCT_ANALYSIS" })).toBe(1);
    expect(getCreditCost({ operationType: "PRODUCT_ANALYSIS", outputCount: 5 })).toBe(1);
  });

  it("charges IMAGE_PROCESSING a flat per-job rate", () => {
    expect(getCreditCost({ operationType: "IMAGE_PROCESSING" })).toBe(1);
  });

  it("charges STORE_VISUAL_GENERATION per output", () => {
    expect(getCreditCost({ operationType: "STORE_VISUAL_GENERATION", outputCount: 3 })).toBe(6);
  });

  describe("IMAGE_GENERATION", () => {
    it("charges TEXT_TO_IMAGE at the base rate per output", () => {
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "TEXT_TO_IMAGE", outputCount: 1 })).toBe(2);
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "TEXT_TO_IMAGE", outputCount: 3 })).toBe(6);
    });

    it("charges IMAGE_TO_IMAGE/IMAGE_EDIT more per output than a fresh generation", () => {
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "IMAGE_TO_IMAGE", outputCount: 1 })).toBe(3);
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "IMAGE_EDIT", outputCount: 1 })).toBe(3);
    });

    it("charges VARIATION at the base rate, same as TEXT_TO_IMAGE", () => {
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "VARIATION", outputCount: 1 })).toBe(2);
    });

    it("falls back to the default mode cost when no mode is given (every pre-Creative-Studio generationType)", () => {
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", outputCount: 1 })).toBe(2);
    });

    it("never charges for fewer than 1 output even if outputCount is 0 or negative", () => {
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "TEXT_TO_IMAGE", outputCount: 0 })).toBe(2);
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "TEXT_TO_IMAGE", outputCount: -5 })).toBe(2);
    });

    it("defaults outputCount to 1 when omitted entirely", () => {
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "TEXT_TO_IMAGE" })).toBe(2);
    });

    it("bills a multi-output request as one logical charge for the full requested count", () => {
      // 3 variations requested up front — one reservation, not three
      // separate 1-output charges (see the module doc comment).
      expect(getCreditCost({ operationType: "IMAGE_GENERATION", mode: "IMAGE_EDIT", outputCount: 4 })).toBe(12);
    });
  });
});
