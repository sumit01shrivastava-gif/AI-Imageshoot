/**
 * Unit tests: services/creative-studio/plan-builder.ts's
 * `buildCreativeGenerationPlan` — the Creative Studio's own,
 * conversational-instruction-driven counterpart to
 * services/generation/build-plan.ts's `buildGenerationPlan`. Verifies it
 * produces a valid `GenerationPlan` with `generationType:
 * "CREATIVE_STUDIO"`, the structural creative/identityConstraints split
 * (Part 4), and correct reference-image wiring for image-to-image edits.
 */
import { describe, expect, it } from "vitest";
import {
  buildCreativeGenerationPlan,
  buildStandaloneCreativeGenerationPlan,
  MissingSourceImagesError,
  ProductNotAnalyzedError,
} from "../../../services/creative-studio/plan-builder";
import { parseParsedIntent } from "../../../services/creative-studio/intent-schema";
import type { ProductDetail } from "../../../db/repositories/shopify-product.repository";
import type { ProductIntelligenceRow } from "../../../db/repositories/product-intelligence.repository";

function product(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: "product-1",
    shop: "test-shop.myshopify.com",
    shopifyProductId: "gid://shopify/Product/1",
    title: "Studio Tote",
    handle: "studio-tote",
    description: "A handcrafted leather tote.",
    productType: "Handbags",
    category: "Handbags",
    vendor: "Acme",
    tags: [],
    status: "ACTIVE",
    syncedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [
      { id: "media-1", originalUrl: "https://cdn.shopify.com/tote-front.jpg", previewUrl: null, altText: "Front", width: 800, height: 600, position: 0 },
      { id: "media-2", originalUrl: "https://cdn.shopify.com/tote-side.jpg", previewUrl: null, altText: "Side", width: 800, height: 600, position: 1 },
    ],
    ...overrides,
  };
}

function intelligence(overrides: Partial<ProductIntelligenceRow> = {}): ProductIntelligenceRow {
  return {
    id: "intel-1",
    shop: "test-shop.myshopify.com",
    productId: "product-1",
    status: "READY",
    errorMessage: null,
    category: "Handbags",
    subcategory: null,
    productType: null,
    material: "Leather",
    primaryColor: "Brown",
    secondaryColors: [],
    pattern: null,
    texture: null,
    style: null,
    useCases: [],
    targetAudience: null,
    genderSuitability: null,
    seasonality: [],
    pricePositioning: null,
    visualCharacteristics: null,
    productDimensions: null,
    packagingCharacteristics: null,
    hardwareComponents: [],
    modelSuitable: false,
    recommendedModelAttributes: null,
    recommendedPoseTypes: [],
    recommendedEnvironments: ["studio"],
    recommendedProps: [],
    recommendedPhotographyStyles: [],
    recommendedAssetTypes: ["product_studio"],
    identityAnchors: {
      category: "Handbags",
      shape: "Rectangular",
      material: "Leather",
      primaryColor: "Brown",
      constructionDetails: [],
      distinctiveHardware: ["gold clasp"],
      brandingVisible: false,
      brandingDescription: null,
    },
    imageAnalyses: [],
    analysisVersion: 1,
    confidence: null,
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProductIntelligenceRow;
}

async function intent(message: string, candidateResultCount = 0) {
  const { HeuristicIntentParser } = await import("../../../services/ai/heuristic-intent-parser");
  const raw = await new HeuristicIntentParser().parseIntent({ message, creativeContext: {}, candidateResultCount });
  return parseParsedIntent(raw);
}

describe("buildCreativeGenerationPlan", () => {
  it("builds a valid CREATIVE_STUDIO plan with identity constraints structurally separate from creative direction", async () => {
    const parsedIntent = await intent("Put my product in a premium lifestyle scene");
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Put my product in a premium lifestyle scene",
    });

    expect(plan.generationType).toBe("CREATIVE_STUDIO");
    expect(plan.creativeIntent).not.toBeNull();
    expect(plan.creativeIntent!.creative.scene).toBe("premium lifestyle scene");
    expect(plan.creativeIntent!.identityConstraints.immutable).toContain("material: Leather");
    expect(plan.creativeIntent!.identityConstraints.instruction).toMatch(/immutable subject/i);
    // The synthesized prompt always includes the identity instruction —
    // never just the creative direction alone (Part 4).
    expect(plan.creativeDirection.prompt).toContain(plan.creativeIntent!.identityConstraints.instruction);
  });

  it("leads the synthesized prompt with the identity instruction, before the creative direction (Part 5's hierarchy)", async () => {
    const parsedIntent = await intent("Put my product in a premium lifestyle scene");
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Put my product in a premium lifestyle scene",
    });

    const identityIndex = plan.creativeDirection.prompt.indexOf(plan.creativeIntent!.identityConstraints.instruction);
    const creativeIndex = plan.creativeDirection.prompt.indexOf("premium lifestyle scene");
    expect(identityIndex).toBe(0); // identity is the very first thing in the prompt
    expect(creativeIndex).toBeGreaterThan(identityIndex);
  });

  it("states explicit reference-image fidelity for an image-to-image follow-up, positioned after identity and before the creative direction", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: "https://signed.example.test/prior-result.png",
      creativeSessionId: "session-1",
      rawInstruction: "Make it brighter",
    });

    expect(plan.creativeDirection.prompt).toMatch(/exact starting point/i);
    const identityIndex = plan.creativeDirection.prompt.indexOf(plan.creativeIntent!.identityConstraints.instruction);
    const referenceIndex = plan.creativeDirection.prompt.indexOf("exact starting point");
    expect(identityIndex).toBe(0);
    expect(referenceIndex).toBeGreaterThan(identityIndex);
  });

  it("states no reference-fidelity clause for a fresh TEXT_TO_IMAGE request (nothing to be faithful to yet)", async () => {
    const parsedIntent = await intent("Put my product in a premium lifestyle scene");
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Put my product in a premium lifestyle scene",
    });
    expect(plan.creativeDirection.prompt).not.toMatch(/exact starting point/i);
  });

  it("never sends the merchant's raw message as the prompt verbatim", async () => {
    const rawInstruction = "asdkjf make it look totally amazeballs pls!!1";
    const parsedIntent = await intent(rawInstruction);
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction,
    });
    expect(plan.creativeDirection.prompt).not.toContain(rawInstruction);
    // The raw instruction is preserved elsewhere, for traceability only.
    expect(plan.creativeIntent!.rawInstruction).toBe(rawInstruction);
  });

  it("includes a referenceImage with role 'previous_result' for an image-to-image follow-up", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: "https://signed.example.test/prior-result.png",
      creativeSessionId: "session-1",
      rawInstruction: "Make it brighter",
    });
    expect(plan.referenceImages).toEqual([{ url: "https://signed.example.test/prior-result.png", role: "previous_result" }]);
    // sourceImages (the ORIGINAL product images) are still present for
    // identity grounding even on a follow-up edit.
    expect(plan.sourceImages.length).toBeGreaterThan(0);
  });

  it("carries no reference image for a fresh TEXT_TO_IMAGE request", async () => {
    const parsedIntent = await intent("Put my product in a premium lifestyle scene");
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Put my product in a premium lifestyle scene",
    });
    expect(plan.referenceImages).toEqual([]);
  });

  it("requests outputCount matching the parsed variation count", async () => {
    const parsedIntent = await intent("Create 3 variations");
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: [],
      parsedIntent,
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Create 3 variations",
    });
    expect(plan.outputCount).toBe(3);
  });

  it("restricts sourceImages to the requested media id when one is given", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    const plan = buildCreativeGenerationPlan({
      product: product(),
      intelligence: intelligence(),
      sourceMediaIds: ["media-2"],
      parsedIntent,
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Make it brighter",
    });
    expect(plan.sourceImages).toHaveLength(1);
    expect(plan.sourceImages[0].mediaId).toBe("media-2");
  });

  it("throws MissingSourceImagesError when the product has no media", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    expect(() =>
      buildCreativeGenerationPlan({
        product: product({ media: [] }),
        intelligence: intelligence(),
        sourceMediaIds: [],
        parsedIntent,
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction: "Make it brighter",
      }),
    ).toThrow(MissingSourceImagesError);
  });

  it("throws ProductNotAnalyzedError when Product Intelligence isn't READY", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    expect(() =>
      buildCreativeGenerationPlan({
        product: product(),
        intelligence: intelligence({ status: "PENDING" }),
        sourceMediaIds: [],
        parsedIntent,
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction: "Make it brighter",
      }),
    ).toThrow(ProductNotAnalyzedError);
  });

  it("throws ProductNotAnalyzedError when there is no Product Intelligence profile at all", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    expect(() =>
      buildCreativeGenerationPlan({
        product: product(),
        intelligence: null,
        sourceMediaIds: [],
        parsedIntent,
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction: "Make it brighter",
      }),
    ).toThrow(ProductNotAnalyzedError);
  });

  describe("protected-element removal (Part 4 worked example)", () => {
    it("never lets 'Remove the logo' reach the prompt as a removal, and records it as blocked", async () => {
      const parsedIntent = await intent("Remove the logo", 1);
      expect(parsedIntent.removeElements).toContain("logo"); // the parser itself has no notion of "protected"

      const plan = buildCreativeGenerationPlan({
        product: product(),
        intelligence: intelligence({
          identityAnchors: {
            category: "Handbags",
            shape: "Rectangular",
            material: "Leather",
            primaryColor: "Brown",
            constructionDetails: [],
            distinctiveHardware: ["gold clasp"],
            brandingVisible: true,
            brandingDescription: "embossed brand logo on the front flap",
          },
        }),
        sourceMediaIds: [],
        parsedIntent,
        previousResultUrl: "https://signed.example.test/prior-result.png",
        creativeSessionId: "session-1",
        rawInstruction: "Remove the logo",
      });

      // The prompt must never contain a "without logo"-style clause — it
      // would directly contradict the identity instruction's own
      // "do not alter any visible logos" a few sentences earlier.
      expect(plan.creativeDirection.prompt).not.toMatch(/without\s+logo/i);
      expect(plan.creativeIntent!.creative.removeElements).not.toContain("logo");
      expect(plan.creativeIntent!.creative.blockedRemovals).toContain("logo");
      // The immutable branding fact is still asserted, unconditionally.
      expect(plan.creativeIntent!.identityConstraints.immutable.some((i) => i.startsWith("branding:"))).toBe(true);
    });

    it("still allows removing a non-protected element (e.g. a shadow) alongside a blocked one", async () => {
      const parsedIntent = await intent("Remove the shadow", 1);
      const plan = buildCreativeGenerationPlan({
        product: product(),
        intelligence: intelligence(),
        sourceMediaIds: [],
        parsedIntent,
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction: "Remove the shadow",
      });

      expect(plan.creativeIntent!.creative.removeElements).toContain("shadow");
      expect(plan.creativeIntent!.creative.blockedRemovals).toEqual([]);
      expect(plan.creativeDirection.prompt).toMatch(/without\s+shadow/i);
    });
  });
});

describe("buildStandaloneCreativeGenerationPlan", () => {
  it("builds a valid CREATIVE_STUDIO plan with no Shopify product/Product Intelligence at all", async () => {
    const parsedIntent = await intent("Put it in a premium lifestyle scene");
    const plan = buildStandaloneCreativeGenerationPlan({
      parsedIntent,
      uploadedReferenceImageUrls: [],
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Put it in a premium lifestyle scene",
    });

    expect(plan.generationType).toBe("CREATIVE_STUDIO");
    // Never fabricated — no product, no catalog facts, no analyzed
    // identity anchors.
    expect(plan.sourceProductId).toBeNull();
    expect(plan.sourceImages).toEqual([]);
    expect(plan.productFacts).toEqual({ identityAnchors: null, title: null, description: null, attributes: null });
    expect(plan.creativeIntent).not.toBeNull();
    expect(plan.creativeIntent!.identityConstraints.immutable).toEqual([]);
  });

  it("includes an uploaded reference image in referenceImages and asserts its fidelity in the prompt", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    const plan = buildStandaloneCreativeGenerationPlan({
      parsedIntent,
      uploadedReferenceImageUrls: ["https://signed.example.test/uploaded-1.png"],
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Make it brighter",
    });

    expect(plan.referenceImages).toEqual([{ url: "https://signed.example.test/uploaded-1.png", role: "product_original" }]);
    expect(plan.creativeDirection.prompt).toMatch(/uploaded reference image/i);
  });

  it("carries a session's own previous result forward as the reference image for a follow-up turn", async () => {
    const parsedIntent = await intent("Make it brighter", 1);
    const plan = buildStandaloneCreativeGenerationPlan({
      parsedIntent,
      uploadedReferenceImageUrls: [],
      previousResultUrl: "https://signed.example.test/prior-result.png",
      creativeSessionId: "session-1",
      rawInstruction: "Make it brighter",
    });

    expect(plan.referenceImages).toEqual([{ url: "https://signed.example.test/prior-result.png", role: "previous_result" }]);
    expect(plan.creativeDirection.prompt).toMatch(/exact starting point/i);
  });

  it("states no reference-fidelity clause for a fresh request with nothing uploaded and no prior result", async () => {
    const parsedIntent = await intent("Create a clean product photo");
    const plan = buildStandaloneCreativeGenerationPlan({
      parsedIntent,
      uploadedReferenceImageUrls: [],
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Create a clean product photo",
    });

    expect(plan.referenceImages).toEqual([]);
    expect(plan.creativeDirection.prompt).toMatch(/no existing image to preserve/i);
  });

  it("still blocks a protected removal (e.g. \"remove the logo\") even with no Product Intelligence involved", async () => {
    const parsedIntent = await intent("Remove the logo", 1);
    const plan = buildStandaloneCreativeGenerationPlan({
      parsedIntent,
      uploadedReferenceImageUrls: ["https://signed.example.test/uploaded-1.png"],
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction: "Remove the logo",
    });

    expect(plan.creativeIntent!.creative.removeElements).not.toContain("logo");
    expect(plan.creativeIntent!.creative.blockedRemovals).toContain("logo");
    expect(plan.creativeDirection.prompt).not.toMatch(/without\s+logo/i);
  });

  it("never sends the merchant's raw message as the prompt verbatim", async () => {
    const rawInstruction = "asdkjf make it look totally amazeballs pls!!1";
    const parsedIntent = await intent(rawInstruction);
    const plan = buildStandaloneCreativeGenerationPlan({
      parsedIntent,
      uploadedReferenceImageUrls: [],
      previousResultUrl: null,
      creativeSessionId: "session-1",
      rawInstruction,
    });

    expect(plan.creativeDirection.prompt).not.toContain(rawInstruction);
    expect(plan.creativeIntent!.rawInstruction).toBe(rawInstruction);
  });
});
