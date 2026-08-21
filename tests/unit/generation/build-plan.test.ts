import { describe, expect, it } from "vitest";
import {
  buildGenerationPlan,
  MissingSourceImagesError,
  ProductNotAnalyzedError,
} from "../../../services/generation/build-plan";
import { getBuiltInPreset } from "../../../services/generation/brand-style-presets";
import type { ProductDetail } from "../../../db/repositories/shopify-product.repository";
import type { ProductIntelligenceRow } from "../../../db/repositories/product-intelligence.repository";

function product(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: "product-1",
    shop: "shop-a.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1",
    title: "Red Leather Handbag",
    handle: "red-leather-handbag",
    description: "A handcrafted red leather handbag.",
    productType: "Handbags",
    category: "Apparel & Accessories > Handbags",
    vendor: "Acme",
    tags: ["leather", "bestseller"],
    status: "ACTIVE",
    syncedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    media: [
      { id: "media-1", originalUrl: "https://cdn/1.jpg", previewUrl: "https://cdn/1-small.jpg", altText: "Front", width: 800, height: 600, position: 0 },
      { id: "media-2", originalUrl: "https://cdn/2.jpg", previewUrl: null, altText: null, width: 800, height: 600, position: 1 },
    ],
    ...overrides,
  };
}

function readyIntelligence(overrides: Partial<ProductIntelligenceRow> = {}): ProductIntelligenceRow {
  return {
    id: "intel-1",
    shop: "shop-a.myshopify.com",
    productId: "product-1",
    status: "READY",
    errorMessage: null,
    category: "Handbags",
    subcategory: "Tote",
    productType: "Handbags",
    material: "Leather",
    primaryColor: "Red",
    secondaryColors: ["Gold"],
    pattern: null,
    texture: null,
    style: "Structured",
    useCases: ["Everyday carry"],
    targetAudience: "Adults",
    genderSuitability: "women",
    seasonality: [],
    pricePositioning: "premium",
    visualCharacteristics: null,
    productDimensions: null,
    packagingCharacteristics: null,
    hardwareComponents: ["Gold zipper"],
    modelSuitable: true,
    recommendedModelAttributes: null,
    recommendedPoseTypes: ["carried/worn detail"],
    recommendedEnvironments: ["studio", "lifestyle setting"],
    recommendedProps: [],
    recommendedPhotographyStyles: ["editorial"],
    recommendedAssetTypes: ["product_studio", "lifestyle"],
    identityAnchors: {
      category: "Handbags",
      shape: "Rectangular",
      material: "Leather",
      primaryColor: "Red",
      constructionDetails: ["structured body"],
      distinctiveHardware: ["gold zipper"],
      brandingVisible: false,
      brandingDescription: null,
    },
    imageAnalyses: [],
    analysisVersion: 1,
    confidence: 0.9,
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProductIntelligenceRow;
}

describe("buildGenerationPlan", () => {
  it("carries identityAnchors from Product Intelligence into productFacts — never inventing or dropping them", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "PRODUCT_CLEANUP",
    });

    expect(plan.productFacts.identityAnchors).toEqual({
      category: "Handbags",
      shape: "Rectangular",
      material: "Leather",
      primaryColor: "Red",
      constructionDetails: ["structured body"],
      distinctiveHardware: ["gold zipper"],
      brandingVisible: false,
      brandingDescription: null,
    });
  });

  it("only includes the requested source images, never trusting an unrelated id", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1", "media-does-not-belong-to-this-product"],
      generationType: "PRODUCT_CLEANUP",
    });

    expect(plan.sourceImages).toEqual([
      { mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 },
    ]);
  });

  it("uses the full-resolution URL, not the preview", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "PRODUCT_CLEANUP",
    });
    expect(plan.sourceImages[0].url).toBe("https://cdn/1.jpg");
  });

  it("throws MissingSourceImagesError when no requested id matches any of the product's media", () => {
    expect(() =>
      buildGenerationPlan({
        product: product(),
        intelligence: readyIntelligence(),
        sourceMediaIds: ["not-a-real-media-id"],
        generationType: "PRODUCT_CLEANUP",
      }),
    ).toThrow(MissingSourceImagesError);
  });

  it("throws ProductNotAnalyzedError when there is no Product Intelligence profile", () => {
    expect(() =>
      buildGenerationPlan({
        product: product(),
        intelligence: null,
        sourceMediaIds: ["media-1"],
        generationType: "PRODUCT_CLEANUP",
      }),
    ).toThrow(ProductNotAnalyzedError);
  });

  it("throws ProductNotAnalyzedError when the profile exists but isn't READY yet (still PROCESSING)", () => {
    expect(() =>
      buildGenerationPlan({
        product: product(),
        intelligence: readyIntelligence({ status: "PROCESSING" }),
        sourceMediaIds: ["media-1"],
        generationType: "PRODUCT_CLEANUP",
      }),
    ).toThrow(ProductNotAnalyzedError);
  });

  it("allows generation against a READY-but-stale profile (staleness ≠ invalid identity)", () => {
    // status stays READY even when the derived display state is "stale" —
    // see services/intelligence/stale.ts. Only `status` gates generation.
    expect(() =>
      buildGenerationPlan({
        product: product({ shopifyUpdatedAt: new Date("2030-01-01T00:00:00Z") }),
        intelligence: readyIntelligence(),
        sourceMediaIds: ["media-1"],
        generationType: "PRODUCT_CLEANUP",
      }),
    ).not.toThrow();
  });

  it("synthesizes a PRODUCT_CLEANUP prompt from structured fields, never merchant-typed text, and explicitly instructs identity preservation", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "PRODUCT_CLEANUP",
    });

    expect(plan.creativeDirection.prompt).toContain("Red");
    expect(plan.creativeDirection.prompt).toContain("Leather");
    expect(plan.creativeDirection.prompt).toContain("Handbags");
    expect(plan.creativeDirection.prompt.toLowerCase()).toContain("preserve");
  });

  it("carries modelConfiguration from Product Intelligence's model-suitability fields", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "PRODUCT_CLEANUP",
    });

    expect(plan.modelConfiguration).toEqual({
      modelSuitable: true,
      recommendedModelAttributes: null,
      recommendedPoseTypes: ["carried/worn detail"],
    });
  });

  it("modelConfiguration is null when Product Intelligence never determined suitability", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence({ modelSuitable: null }),
      sourceMediaIds: ["media-1"],
      generationType: "PRODUCT_CLEANUP",
    });
    expect(plan.modelConfiguration).toBeNull();
  });

  it("visualDirectionOverride.environment overrides Product Intelligence's recommendation", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "LIFESTYLE",
      visualDirectionOverride: { environment: "a rooftop garden at sunset" },
    });
    expect(plan.creativeDirection.environment).toBe("a rooftop garden at sunset");
    expect(plan.creativeDirection.prompt).toContain("rooftop garden");
  });

  it("outputCountOverride is reflected on the plan (not wired to any route — test-only)", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "PRODUCT_CLEANUP",
      outputCountOverride: 3,
    });
    expect(plan.outputCount).toBe(3);
  });
});

describe("LIFESTYLE generation type", () => {
  it("populates lifestyleScene and brandStyle from a resolved brand style preset", () => {
    const preset = getBuiltInPreset("luxury-editorial")!;
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "LIFESTYLE",
      brandStylePreset: preset,
    });

    expect(plan.lifestyleScene).not.toBeNull();
    expect(plan.lifestyleScene?.sceneType).toBe("environmental");
    expect(plan.lifestyleScene?.surface).toBe(preset.attributes.surface);
    expect(plan.brandStyle).not.toBeNull();
    expect(plan.brandStyle?.photographyStyle).toBe(preset.attributes.photographyStyle);
    expect(plan.creativeDirection.prompt).toContain("Lifestyle product photography");
    expect(plan.creativeDirection.environment).toBe(preset.attributes.environment);
  });

  it("falls back to category-aware defaults when no preset is chosen", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "LIFESTYLE",
    });

    expect(plan.brandStyle).toBeNull();
    expect(plan.lifestyleScene).not.toBeNull();
    expect(plan.lifestyleScene?.surface).not.toBeNull();
  });

  it("a lifestyleSceneOverride's fields win over the preset's own", () => {
    const preset = getBuiltInPreset("luxury-editorial")!;
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "LIFESTYLE",
      brandStylePreset: preset,
      lifestyleSceneOverride: { mood: "playful" },
    });

    expect(plan.lifestyleScene?.mood).toBe("playful");
  });

  it("every non-LIFESTYLE generationType keeps lifestyleScene/brandStyle null, even if a preset is passed", () => {
    const preset = getBuiltInPreset("luxury-editorial")!;
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "PRODUCT_CLEANUP",
      brandStylePreset: preset,
    });

    expect(plan.lifestyleScene).toBeNull();
    expect(plan.brandStyle).toBeNull();
  });

  it("the prompt always includes the identity-preservation instruction", () => {
    const plan = buildGenerationPlan({
      product: product(),
      intelligence: readyIntelligence(),
      sourceMediaIds: ["media-1"],
      generationType: "LIFESTYLE",
    });
    expect(plan.creativeDirection.prompt).toContain("Preserve the product exactly as shown in the source image");
  });
});
