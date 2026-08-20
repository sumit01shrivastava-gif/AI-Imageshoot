import { describe, expect, it } from "vitest";
import {
  ProductIntelligenceSchema,
  parseProductIntelligenceOutput,
  InvalidProductIntelligenceOutputError,
} from "../../../services/intelligence/schema";

function validOutput(overrides: Record<string, unknown> = {}) {
  return {
    category: "Handbags",
    subcategory: "Tote",
    productType: "Bag",
    material: "Leather",
    primaryColor: "Red",
    secondaryColors: ["Black"],
    pattern: null,
    texture: "Smooth",
    style: "Classic",
    useCases: ["Everyday carry"],
    targetAudience: "Adults",
    genderSuitability: "unisex",
    seasonality: [],
    pricePositioning: "premium",
    visualCharacteristics: { finish: "matte" },
    productDimensions: null,
    packagingCharacteristics: null,
    hardwareComponents: ["gold zipper"],
    modelSuitable: true,
    recommendedModelAttributes: null,
    recommendedPoseTypes: ["carried"],
    recommendedEnvironments: ["studio"],
    recommendedProps: [],
    recommendedPhotographyStyles: ["studio"],
    recommendedAssetTypes: ["product_studio", "lifestyle"],
    identityAnchors: {
      category: "Handbags",
      shape: "Tote",
      material: "Leather",
      primaryColor: "Red",
      constructionDetails: ["double stitching"],
      distinctiveHardware: ["gold zipper"],
      brandingVisible: false,
      brandingDescription: null,
    },
    imageAnalyses: [
      {
        mediaId: "media-1",
        url: "https://cdn.shopify.com/1.jpg",
        relevance: "primary",
        qualityIndicators: { sharpness: "high", lighting: "high", backgroundClarity: "studio" },
        identityObservations: ["red leather exterior"],
      },
    ],
    confidence: 0.9,
    ...overrides,
  };
}

describe("ProductIntelligenceSchema", () => {
  it("accepts a fully-populated, valid analysis result", () => {
    const result = ProductIntelligenceSchema.safeParse(validOutput());
    expect(result.success).toBe(true);
  });

  it("accepts a minimal result relying on defaults for optional fields", () => {
    const result = ProductIntelligenceSchema.safeParse({
      category: "Furniture",
      modelSuitable: false,
      recommendedAssetTypes: ["product_studio"],
      identityAnchors: { category: "Furniture" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secondaryColors).toEqual([]);
      expect(result.data.useCases).toEqual([]);
      expect(result.data.identityAnchors.brandingVisible).toBe(false);
    }
  });

  it("rejects output missing the required category", () => {
    const { category: _category, ...rest } = validOutput();
    void _category;
    const result = ProductIntelligenceSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects output missing identityAnchors", () => {
    const { identityAnchors: _identityAnchors, ...rest } = validOutput();
    void _identityAnchors;
    const result = ProductIntelligenceSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects an empty recommendedAssetTypes array", () => {
    const result = ProductIntelligenceSchema.safeParse(validOutput({ recommendedAssetTypes: [] }));
    expect(result.success).toBe(false);
  });

  it("rejects a recommendedAssetTypes value outside the known enum", () => {
    const result = ProductIntelligenceSchema.safeParse(
      validOutput({ recommendedAssetTypes: ["totally_made_up_type"] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean modelSuitable", () => {
    const result = ProductIntelligenceSchema.safeParse(validOutput({ modelSuitable: "yes" }));
    expect(result.success).toBe(false);
  });

  it("rejects a confidence value outside [0, 1]", () => {
    expect(ProductIntelligenceSchema.safeParse(validOutput({ confidence: 1.5 })).success).toBe(false);
    expect(ProductIntelligenceSchema.safeParse(validOutput({ confidence: -0.1 })).success).toBe(false);
  });

  it("rejects an invalid genderSuitability enum value", () => {
    const result = ProductIntelligenceSchema.safeParse(validOutput({ genderSuitability: "other" }));
    expect(result.success).toBe(false);
  });

  it("tolerates unrecognized extra fields from a provider (not .strict())", () => {
    const result = ProductIntelligenceSchema.safeParse(
      validOutput({ providerInternalTraceId: "abc-123" }),
    );
    expect(result.success).toBe(true);
  });
});

describe("parseProductIntelligenceOutput", () => {
  it("returns validated data for well-formed output", () => {
    const data = parseProductIntelligenceOutput(validOutput());
    expect(data.category).toBe("Handbags");
    expect(data.identityAnchors.category).toBe("Handbags");
  });

  it("throws InvalidProductIntelligenceOutputError — never silently accepts — for malformed output", () => {
    expect(() => parseProductIntelligenceOutput({ nonsense: true })).toThrow(
      InvalidProductIntelligenceOutputError,
    );
  });

  it("throws for completely non-object output (arbitrary prose, not structured data)", () => {
    expect(() => parseProductIntelligenceOutput("just some prose the model wrote")).toThrow(
      InvalidProductIntelligenceOutputError,
    );
  });

  it("includes field-level detail in the thrown error for debugging", () => {
    try {
      parseProductIntelligenceOutput({ category: "X" }); // missing modelSuitable, recommendedAssetTypes, identityAnchors
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProductIntelligenceOutputError);
      const issues = (error as InstanceType<typeof InvalidProductIntelligenceOutputError>).issues;
      expect(issues.length).toBeGreaterThan(0);
    }
  });
});
