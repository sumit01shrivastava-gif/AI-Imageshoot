import { describe, expect, it } from "vitest";
import { buildGenerateImageInput } from "../../../services/generation/build-input";
import { parseGenerationPlan } from "../../../services/generation/schema";

function plan() {
  return parseGenerationPlan({
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
      negativeConstraints: ["no watermark"],
      environment: null,
      lighting: null,
      composition: null,
    },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 2,
    modelConfiguration: null,
    brandStyle: { visualTone: "luxury" },
    constraints: [],
  });
}

describe("buildGenerateImageInput", () => {
  it("maps every plan field onto the provider input verbatim", () => {
    const input = buildGenerateImageInput(plan(), 1);

    expect(input.generationType).toBe("PRODUCT_CLEANUP");
    expect(input.sourceImages).toEqual([{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 }]);
    expect(input.productFacts).toEqual({
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
    });
    expect(input.creativeDirection.prompt).toBe("Clean product photography of the red leather handbag.");
    expect(input.creativeDirection.negativeConstraints).toEqual(["no watermark"]);
    expect(input.aspectRatio).toBe("1:1");
    expect(input.outputFormat).toBe("png");
    expect(input.quality).toBe("standard");
    expect(input.outputCount).toBe(2);
    expect(input.brandStyle).toEqual({ visualTone: "luxury" });
  });

  it("passes the given attempt number through, distinct per call", () => {
    expect(buildGenerateImageInput(plan(), 1).attempt).toBe(1);
    expect(buildGenerateImageInput(plan(), 2).attempt).toBe(2);
  });
});
