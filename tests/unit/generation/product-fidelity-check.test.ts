/**
 * Unit tests: services/generation/product-fidelity-check.ts —
 * `checkProductFidelity`, the deterministic "final internal generation
 * check" (PRODUCT FIDELITY quality-floor pass). Pure structural checks
 * against an already-built `GenerationPlan` — never a real vision check,
 * never chain-of-thought, never throws.
 */
import { describe, expect, it } from "vitest";
import { checkProductFidelity } from "../../../services/generation/product-fidelity-check";
import { parseGenerationPlan, type GenerationPlan } from "../../../services/generation/schema";

function basePlan(overrides: Record<string, unknown> = {}): GenerationPlan {
  return parseGenerationPlan({
    generationType: "PRODUCT_CLEANUP",
    assetType: "product_studio",
    category: "Handbags",
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
      prompt: "Preserve the product exactly as shown in the source image — it is the source of truth. Clean product photography.",
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
    lifestyleScene: null,
    referenceImages: [],
    constraints: [],
    ...overrides,
  });
}

describe("checkProductFidelity", () => {
  it("referenceProductPresent/productFidelityRequired are true when sourceImages exist", () => {
    const result = checkProductFidelity(basePlan());
    expect(result.referenceProductPresent).toBe(true);
    expect(result.productFidelityRequired).toBe(true);
  });

  it("referenceProductPresent/productFidelityRequired are false for a from-scratch plan with no images at all", () => {
    const result = checkProductFidelity(
      basePlan({ sourceProductId: null, sourceImages: [], productFacts: { identityAnchors: null }, referenceImages: [] }),
    );
    expect(result.referenceProductPresent).toBe(false);
    expect(result.productFidelityRequired).toBe(false);
    // With nothing to be faithful to, identity/interaction checks trivially pass.
    expect(result.productIdentityPreserved).toBe(true);
  });

  it("referenceProductPresent is true via referenceImages alone (no sourceImages)", () => {
    const result = checkProductFidelity(
      basePlan({
        sourceProductId: null,
        sourceImages: [],
        productFacts: { identityAnchors: null },
        referenceImages: [{ url: "https://cdn/ref.png", role: "previous_result" }],
      }),
    );
    expect(result.referenceProductPresent).toBe(true);
  });

  it("productIdentityPreserved is true when the prompt carries the shared 'source of truth' preservation phrase", () => {
    const result = checkProductFidelity(basePlan());
    expect(result.productIdentityPreserved).toBe(true);
  });

  it("productIdentityPreserved is false — the real regression this check exists to catch — when a reference product exists but the prompt carries no preservation instruction at all", () => {
    const result = checkProductFidelity(basePlan({ creativeDirection: { prompt: "A beautiful product photo.", negativeConstraints: [], environment: null, lighting: null, composition: null } }));
    expect(result.productIdentityPreserved).toBe(false);
  });

  it("userExplicitInstructionsPreserved is true for a non-Creative-Studio plan (no creativeIntent to check)", () => {
    const result = checkProductFidelity(basePlan());
    expect(result.userExplicitInstructionsPreserved).toBe(true);
  });

  it("productModelInteractionValid is true when no model is requested", () => {
    const result = checkProductFidelity(basePlan());
    expect(result.productModelInteractionValid).toBe(true);
  });

  it("productModelInteractionValid is true for MODEL_SHOOT when the prompt actually names an interaction", () => {
    const result = checkProductFidelity(
      basePlan({
        generationType: "MODEL_SHOOT",
        creativeDirection: {
          prompt: "Preserve the product exactly as shown in the source image — it is the source of truth. Model photography, the model wearing it naturally on the wrist.",
          negativeConstraints: [],
          environment: null,
          lighting: null,
          composition: null,
        },
      }),
    );
    expect(result.productModelInteractionValid).toBe(true);
  });

  it("productModelInteractionValid is false — the real regression this check exists to catch — for MODEL_SHOOT when the prompt never actually says how the model relates to the product", () => {
    const result = checkProductFidelity(
      basePlan({
        generationType: "MODEL_SHOOT",
        creativeDirection: {
          prompt: "Preserve the product exactly as shown in the source image — it is the source of truth. Model photography, dramatic lighting.",
          negativeConstraints: [],
          environment: null,
          lighting: null,
          composition: null,
        },
      }),
    );
    expect(result.productModelInteractionValid).toBe(false);
  });

  it("productVisibilityAdequate is true in the ordinary case", () => {
    const result = checkProductFidelity(basePlan());
    expect(result.productVisibilityAdequate).toBe(true);
  });

  it("productVisibilityAdequate is false for the pathological case of a negative constraint naming the product's own category", () => {
    const result = checkProductFidelity(
      basePlan({
        creativeDirection: {
          prompt: "Preserve the product exactly as shown in the source image — it is the source of truth.",
          negativeConstraints: ["the handbags"],
          environment: null,
          lighting: null,
          composition: null,
        },
      }),
    );
    expect(result.productVisibilityAdequate).toBe(false);
  });

  it("negativeConstraintsPresent reflects whether any negative constraints exist", () => {
    expect(checkProductFidelity(basePlan()).negativeConstraintsPresent).toBe(false);
    expect(
      checkProductFidelity(
        basePlan({
          creativeDirection: {
            prompt: "Preserve the product exactly as shown in the source image — it is the source of truth.",
            negativeConstraints: ["generic backdrop"],
            environment: null,
            lighting: null,
            composition: null,
          },
        }),
      ).negativeConstraintsPresent,
    ).toBe(true);
  });

  it("never throws for a plan with a null category and no creativeIntent (malformed/absent reference-related data)", () => {
    expect(() => checkProductFidelity(basePlan({ category: null }))).not.toThrow();
    const result = checkProductFidelity(basePlan({ category: null }));
    expect(result.productVisibilityAdequate).toBe(true);
  });
});
