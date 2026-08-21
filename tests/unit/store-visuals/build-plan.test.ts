import { describe, expect, it } from "vitest";
import { buildStoreVisualPlan } from "../../../services/store-visuals/build-plan";
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
    useCases: [],
    targetAudience: null,
    genderSuitability: null,
    seasonality: [],
    pricePositioning: null,
    visualCharacteristics: null,
    productDimensions: null,
    packagingCharacteristics: null,
    hardwareComponents: [],
    modelSuitable: null,
    recommendedModelAttributes: null,
    recommendedPoseTypes: [],
    recommendedEnvironments: [],
    recommendedProps: [],
    recommendedPhotographyStyles: [],
    recommendedAssetTypes: [],
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

describe("buildStoreVisualPlan — zero products (fully generic visual)", () => {
  it("builds a valid HOMEPAGE_HERO plan with no products referenced", () => {
    const plan = buildStoreVisualPlan({ visualType: "HOMEPAGE_HERO", products: [] });
    expect(plan.products).toEqual([]);
    expect(plan.creativeDirection.prompt).toContain("homepage hero");
    expect(plan.creativeDirection.prompt).toContain("Do not render any text, logos, or typography.");
    // No products referenced — the "preserve each featured product"
    // instruction must not appear (nothing to preserve).
    expect(plan.creativeDirection.prompt).not.toContain("Preserve each featured product");
  });

  it("defaults HOMEPAGE_HERO/COLLECTION_BANNER to a wide 21:9 ratio, STORE_CTA to 1:1", () => {
    expect(buildStoreVisualPlan({ visualType: "HOMEPAGE_HERO", products: [] }).aspectRatio).toBe("21:9");
    expect(buildStoreVisualPlan({ visualType: "COLLECTION_BANNER", products: [] }).aspectRatio).toBe("21:9");
    expect(buildStoreVisualPlan({ visualType: "STORE_CTA", products: [] }).aspectRatio).toBe("1:1");
  });

  it("an explicit aspectRatioOverride wins over the per-type default", () => {
    const plan = buildStoreVisualPlan({ visualType: "HOMEPAGE_HERO", products: [], aspectRatioOverride: "1:1" });
    expect(plan.aspectRatio).toBe("1:1");
  });

  it("never throws for a product with no Product Intelligence at all", () => {
    expect(() =>
      buildStoreVisualPlan({ visualType: "STORE_CTA", products: [{ product: product(), intelligence: null }] }),
    ).not.toThrow();
  });
});

describe("buildStoreVisualPlan — one or more referenced products", () => {
  it("includes each product's title in the prompt and preserves identity when analyzed", () => {
    const plan = buildStoreVisualPlan({
      visualType: "COLLECTION_BANNER",
      products: [{ product: product(), intelligence: readyIntelligence() }],
    });
    expect(plan.products).toHaveLength(1);
    expect(plan.products[0].productId).toBe("product-1");
    expect(plan.products[0].identityAnchors).not.toBeNull();
    expect(plan.creativeDirection.prompt).toContain("Red Leather Handbag");
    expect(plan.creativeDirection.prompt).toContain("Preserve each featured product");
  });

  it("captures identity anchors as null (never throws) for a product that hasn't been analyzed", () => {
    const plan = buildStoreVisualPlan({
      visualType: "COLLECTION_BANNER",
      products: [{ product: product(), intelligence: null }],
    });
    expect(plan.products[0].identityAnchors).toBeNull();
    // Still referenced by title even without analysis.
    expect(plan.creativeDirection.prompt).toContain("Red Leather Handbag");
  });

  it("supports multiple products in one visual, in order", () => {
    const productA = product({ id: "product-a", title: "Product A" });
    const productB = product({ id: "product-b", title: "Product B" });
    const plan = buildStoreVisualPlan({
      visualType: "HOMEPAGE_HERO",
      products: [
        { product: productA, intelligence: null },
        { product: productB, intelligence: null },
      ],
    });
    expect(plan.products.map((p) => p.productId)).toEqual(["product-a", "product-b"]);
    expect(plan.creativeDirection.prompt).toContain("Product A, Product B");
  });
});

describe("buildStoreVisualPlan — brand style preset", () => {
  it("applies a resolved preset's attributes to brandStyle and the prompt", () => {
    const preset = getBuiltInPreset("clean-commercial")!;
    const plan = buildStoreVisualPlan({ visualType: "STORE_CTA", products: [], brandStylePreset: preset });
    expect(plan.brandStyle).not.toBeNull();
    expect(plan.creativeDirection.prompt).toContain("call-to-action");
  });

  it("builds a valid plan with no preset chosen", () => {
    const plan = buildStoreVisualPlan({ visualType: "STORE_CTA", products: [] });
    expect(plan.brandStyle).toBeNull();
  });
});
