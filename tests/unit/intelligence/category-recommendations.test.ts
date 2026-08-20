import { describe, expect, it } from "vitest";
import { ASSET_TYPES, getCategoryRecommendation } from "../../../services/intelligence/category-recommendations";

describe("getCategoryRecommendation", () => {
  it("recommends model-suitable, wearable-focused assets for jewelry", () => {
    const result = getCategoryRecommendation("Fine Jewelry > Rings");
    expect(result.modelSuitable).toBe(true);
    expect(result.recommendedAssetTypes).toEqual(
      expect.arrayContaining(["product_studio", "model_shoot"]),
    );
  });

  it("recommends non-model, scene-focused assets for furniture", () => {
    const result = getCategoryRecommendation("Living Room Furniture > Sofas");
    expect(result.modelSuitable).toBe(false);
    expect(result.recommendedEnvironments).toEqual(expect.arrayContaining(["living room"]));
  });

  it("recommends model-suitable assets for shoes", () => {
    const result = getCategoryRecommendation("Footwear > Sneakers");
    expect(result.modelSuitable).toBe(true);
  });

  it("recommends scene/serving assets, not model shots, for food", () => {
    const result = getCategoryRecommendation("Grocery > Snacks");
    expect(result.modelSuitable).toBe(false);
    expect(result.recommendedAssetTypes).toContain("packaging");
  });

  it("is case-insensitive", () => {
    const lower = getCategoryRecommendation("jewelry");
    const upper = getCategoryRecommendation("JEWELRY");
    expect(lower).toEqual(upper);
  });

  it("falls back to a safe default for an unrecognized category, never throwing", () => {
    const result = getCategoryRecommendation("Completely Unknown Category XYZ");
    expect(result.recommendedAssetTypes.length).toBeGreaterThan(0);
    expect(result.modelSuitable).toBe(false);
  });

  it("returns every recommended asset type from the known enum set", () => {
    for (const category of ["jewelry", "furniture", "shoes", "food", "unknown-xyz"]) {
      const result = getCategoryRecommendation(category);
      for (const assetType of result.recommendedAssetTypes) {
        expect(ASSET_TYPES).toContain(assetType);
      }
    }
  });
});
