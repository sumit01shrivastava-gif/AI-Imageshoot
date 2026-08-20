import { describe, expect, it } from "vitest";
import {
  parseGenerationPlan,
  InvalidGenerationPlanError,
  assertValidGenerateImageResult,
  InvalidGenerationResultError,
} from "../../../services/generation/schema";

function validPlan(overrides: Record<string, unknown> = {}) {
  return {
    generationType: "PRODUCT_CLEANUP",
    assetType: "product_studio",
    sourceProductId: "product-1",
    sourceImages: [{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 }],
    productFacts: {
      identityAnchors: {
        category: "Handbags",
        shape: null,
        material: "Leather",
        primaryColor: "Red",
        constructionDetails: [],
        distinctiveHardware: [],
        brandingVisible: false,
        brandingDescription: null,
      },
    },
    creativeDirection: {
      prompt: "Clean product photography of the red leather handbag.",
      negativeConstraints: [],
      environment: null,
      lighting: null,
      composition: null,
    },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    modelConfiguration: null,
    brandStyle: null,
    constraints: [],
    ...overrides,
  };
}

describe("parseGenerationPlan", () => {
  it("accepts a well-formed plan", () => {
    const plan = parseGenerationPlan(validPlan());
    expect(plan.generationType).toBe("PRODUCT_CLEANUP");
    expect(plan.productFacts.identityAnchors?.category).toBe("Handbags");
  });

  it("accepts a plan whose product has never been analyzed (identityAnchors: null)", () => {
    const plan = parseGenerationPlan(validPlan({ productFacts: { identityAnchors: null } }));
    expect(plan.productFacts.identityAnchors).toBeNull();
  });

  it("rejects a plan with no source images — never silently proceeds with zero inputs", () => {
    expect(() => parseGenerationPlan(validPlan({ sourceImages: [] }))).toThrow(InvalidGenerationPlanError);
  });

  it("rejects an unknown generationType", () => {
    expect(() => parseGenerationPlan(validPlan({ generationType: "NOT_A_REAL_TYPE" }))).toThrow(
      InvalidGenerationPlanError,
    );
  });

  it("rejects outputCount above the max (4)", () => {
    expect(() => parseGenerationPlan(validPlan({ outputCount: 10 }))).toThrow(InvalidGenerationPlanError);
  });

  it("rejects outputCount below 1", () => {
    expect(() => parseGenerationPlan(validPlan({ outputCount: 0 }))).toThrow(InvalidGenerationPlanError);
  });

  it("rejects a plan with an empty creativeDirection.prompt — never a blank/implicit prompt", () => {
    expect(() =>
      parseGenerationPlan(
        validPlan({
          creativeDirection: { prompt: "", negativeConstraints: [], environment: null, lighting: null, composition: null },
        }),
      ),
    ).toThrow(InvalidGenerationPlanError);
  });

  it("reports every validation issue, not just the first", () => {
    try {
      parseGenerationPlan(validPlan({ sourceImages: [], generationType: "BOGUS" }));
      expect.fail("expected parseGenerationPlan to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidGenerationPlanError);
      expect((error as InvalidGenerationPlanError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("assertValidGenerateImageResult", () => {
  it("accepts a result with at least one well-formed output", () => {
    expect(() =>
      assertValidGenerateImageResult({
        outputs: [{ data: new Uint8Array([1, 2, 3]), contentType: "image/png" }],
      }),
    ).not.toThrow();
  });

  it("rejects a result with zero outputs", () => {
    expect(() => assertValidGenerateImageResult({ outputs: [] })).toThrow(InvalidGenerationResultError);
  });

  it("rejects an output with empty image data", () => {
    expect(() =>
      assertValidGenerateImageResult({ outputs: [{ data: new Uint8Array([]), contentType: "image/png" }] }),
    ).toThrow(InvalidGenerationResultError);
  });

  it("rejects an output missing a contentType", () => {
    expect(() =>
      assertValidGenerateImageResult({
        outputs: [{ data: new Uint8Array([1]), contentType: "" }],
      }),
    ).toThrow(InvalidGenerationResultError);
  });
});
