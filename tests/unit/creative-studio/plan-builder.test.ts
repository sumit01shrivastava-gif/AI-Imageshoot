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

  describe("Part Q #5/#6 — product reference: environment change + premium advertising composition, identity preserved", () => {
    it("an environment + premium-advertising-composition request reaches the plan/brief/prompt while identity stays immutable", async () => {
      const rawInstruction = "Put my product in a marble kitchen and make it a premium advertising campaign";
      const parsedIntent = await intent(rawInstruction, 0);
      const plan = buildCreativeGenerationPlan({
        product: product(),
        intelligence: intelligence(),
        sourceMediaIds: [],
        parsedIntent,
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      expect(plan.creativeIntent!.creative.scene).toMatch(/marble kitchen/i);
      expect(plan.creativeIntent!.creative.composition).toMatch(/advertising/i);
      expect(plan.creativeIntent!.creative.style).toContain("premium");

      const brief = plan.creativeIntent!.creativeBrief!;
      expect(brief.transformationRequirements.some((e) => /environment:.*marble kitchen/i.test(e))).toBe(true);
      expect(brief.transformationRequirements.some((e) => /composition:.*advertising/i.test(e))).toBe(true);
      expect(plan.creativeDirection.prompt).toMatch(/marble kitchen/i);
      expect(plan.creativeDirection.prompt).toMatch(/advertising/i);

      // Identity stays immutable throughout — a scene/composition change
      // never loosens product identity preservation.
      expect(plan.creativeIntent!.identityConstraints.immutable.some((i) => i.startsWith("material:"))).toBe(true);
      expect(plan.creativeIntent!.identityConstraints.immutable.some((i) => i.startsWith("primary color:"))).toBe(true);
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

  describe("standalone subject preservation (real production bug: every from-scratch request collapsed to 'the product')", () => {
    it("uses the actual described subject in the synthesized prompt, not the generic 'product' placeholder — the exact real production request", async () => {
      const rawInstruction = "Please create a image for pair of sneakers at beach with cloudy background";
      const parsedIntent = await intent(rawInstruction);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: [],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      expect(plan.category).toBe("pair of sneakers");
      expect(plan.creativeIntent!.creative.subject).toBe("pair of sneakers");
      expect(plan.creativeDirection.prompt).toContain("pair of sneakers");
      expect(plan.creativeDirection.prompt).not.toMatch(/\bthe product\b/i);
    });

    it("generalizes to an arbitrary, non-sneaker subject with no hardcoded special-casing", async () => {
      const rawInstruction = "Generate a luxury black perfume bottle on a marble table";
      const parsedIntent = await intent(rawInstruction);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: [],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      expect(plan.category).toBe("black perfume bottle");
      expect(plan.creativeDirection.prompt).toContain("black perfume bottle");
    });

    it("falls back to the generic 'product' placeholder when no subject can be determined and none was ever established — never an invalid/empty prompt", async () => {
      const rawInstruction = "Make it more premium";
      const parsedIntent = await intent(rawInstruction);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: [],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
        activeSubject: null,
      });

      expect(plan.category).toBe("product");
      expect(plan.creativeIntent!.creative.subject).toBeNull();
      expect(plan.creativeDirection.prompt).toMatch(/\bthe product\b/i);
    });

    it("carries the session's own subject forward on a follow-up turn that doesn't restate it", async () => {
      const rawInstruction = "Make it brighter";
      const parsedIntent = await intent(rawInstruction, 1);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: [],
        previousResultUrl: "https://signed.example.test/prior-result.png",
        creativeSessionId: "session-1",
        rawInstruction,
        activeSubject: "a pair of sneakers",
      });

      expect(plan.category).toBe("a pair of sneakers");
      expect(plan.creativeDirection.prompt).toContain("a pair of sneakers");
      // The subject persists onto this turn's own plan too, so a THIRD
      // turn (which won't restate it either) can keep carrying it
      // forward from here.
      expect(plan.creativeIntent!.creative.subject).toBe("a pair of sneakers");
    });

    it("a fresh turn's own restated subject wins over an older activeSubject carried from a prior turn", async () => {
      const rawInstruction = "Create a red sports car driving through Tokyo at night";
      const parsedIntent = await intent(rawInstruction);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: [],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
        activeSubject: "a pair of sneakers",
      });

      expect(plan.category).toContain("red sports car");
      expect(plan.category).not.toContain("sneakers");
    });

    it("a reference-image-only turn with no textual subject still produces a valid plan (reference images stay optional-but-supported, never mandatory)", async () => {
      const rawInstruction = "make it brighter";
      const parsedIntent = await intent(rawInstruction, 0);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: ["https://signed.example.test/uploaded-1.png"],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
        activeSubject: null,
      });

      expect(plan.category).toBe("product");
      expect(plan.referenceImages).toEqual([{ url: "https://signed.example.test/uploaded-1.png", role: "product_original" }]);
    });
  });

  describe("reference image: preserve identity, transform what's explicitly requested (the real 'yoga' production case)", () => {
    it("preserves identity/appearance while transforming pose, environment, and lighting — none of the requested changes get silently dropped", async () => {
      const rawInstruction = "Make the model perform yoga with a blurred temple in the background and make the background dark.";
      const parsedIntent = await intent(rawInstruction, 1);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: ["https://signed.example.test/model-photo.png"],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      // Identity/appearance is preserved — but the instruction does NOT
      // say "preserve the pose/composition" (the real, previously-fixed
      // bug: a reference image used to implicitly mean "keep the
      // original pose").
      expect(plan.creativeIntent!.identityConstraints.instruction).toMatch(/identity/i);
      expect(plan.creativeIntent!.identityConstraints.instruction).toMatch(/reinterpreted/i);

      // The requested pose change reaches the actual synthesized prompt
      // — this is the core fix: previously nothing captured "yoga" at
      // all, so it never reached the provider.
      expect(plan.creativeDirection.prompt).toContain("yoga");
      expect(plan.creativeIntent!.creative.action).toBe("yoga");

      // The lighting change also reaches the prompt.
      expect(plan.creativeDirection.prompt).toMatch(/dark/i);

      // Part P/Q regression: the Creative Brief demonstrates the pose
      // transformation, the temple environment, and the dark lighting
      // change as concrete, assertable structure — not just somewhere
      // inside a prose paragraph — and the synthesized prompt does NOT
      // collapse to "preserve the original image with a dark blurred
      // background" (identity preservation is asserted, but so is real
      // transformation).
      const brief = plan.creativeIntent!.creativeBrief!;
      expect(brief).not.toBeNull();
      expect(brief.transformationRequirements).toEqual(
        expect.arrayContaining([expect.stringContaining("pose/action: yoga"), expect.stringContaining("environment:")]),
      );
      expect(brief.transformationRequirements.some((entry) => /lighting:.*dark/i.test(entry))).toBe(true);
      expect(brief.overallCreativeDirection).toMatch(/yoga/i);
      expect(plan.creativeDirection.prompt).not.toMatch(/preserve the original image/i);

      // Explicit vs. inferred (this prompt's own requirement): the pose
      // change the merchant explicitly asked for lives in
      // transformationRequirements; the anatomical-plausibility/
      // environment-coherence decisions a creative director would ADD are
      // a separate, clearly-attributed list — never merged into or
      // mistaken for the explicit request.
      expect(brief.inferredCreativeDecisions.length).toBeGreaterThan(0);
      expect(brief.inferredCreativeDecisions.some((d) => /anatomically plausible/i.test(d))).toBe(true);
      expect(brief.inferredCreativeDecisions).not.toContain("pose/action: yoga");
      expect(plan.creativeDirection.prompt).toMatch(/as the creative director/i);
    });

    it("explicit user intent always takes priority over an inferred creative decision — an explicit, deliberately un-moody lighting instruction is never edited/replaced by inference", async () => {
      // A specific, deliberately non-cinematic lighting instruction — must
      // survive untouched and must never trigger the moody/shadow-control
      // inference rule, which only fires for dark/dramatic/cinematic
      // requests (see creative-brief.ts's MOODY_PATTERN).
      const rawInstruction = "Use soft even shadowless lighting";
      const parsedIntent = await intent(rawInstruction, 1);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: ["https://signed.example.test/model-photo.png"],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      const brief = plan.creativeIntent!.creativeBrief!;
      // The EXACT explicit value survives untouched, character for
      // character, regardless of any inferred decision.
      expect(plan.creativeIntent!.creative.lighting).toBe("soft even shadowless lighting");
      expect(brief.transformationRequirements.some((e) => e === "lighting: soft even shadowless lighting")).toBe(true);
      // No inferred decision claims darkness/moodiness — the request was
      // explicitly the opposite, and nothing here contradicts it.
      expect(brief.inferredCreativeDecisions.some((d) => /shadow and highlight control/i.test(d))).toBe(false);
    });

    it("a broad re-creation request ('use this model for a new campaign') still only preserves identity, not the original pose/scene", async () => {
      const rawInstruction = "Create a completely new campaign image using this model, on a rooftop at night";
      const parsedIntent = await intent(rawInstruction, 1);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: ["https://signed.example.test/model-photo.png"],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      expect(plan.creativeIntent!.identityConstraints.instruction).not.toMatch(/preserve\s+(?:the\s+)?(?:original\s+)?pose/i);
      expect(plan.creativeDirection.prompt).toContain("rooftop");
    });

    it("carries the active action forward on a follow-up that doesn't restate it, exactly like activeSubject", async () => {
      const rawInstruction = "Make the lighting more cinematic";
      const parsedIntent = await intent(rawInstruction, 1);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: [],
        previousResultUrl: "https://signed.example.test/prior-result.png",
        creativeSessionId: "session-1",
        rawInstruction,
        activeSubject: "the model",
        activeAction: "yoga",
      });

      expect(plan.creativeIntent!.creative.action).toBe("yoga");
      expect(plan.creativeDirection.prompt).toContain("yoga");
    });

    it("Part Q #4 — model reference: a clothing change reaches the plan/brief/prompt", async () => {
      const rawInstruction = "Change her dress to a red evening gown";
      const parsedIntent = await intent(rawInstruction, 1);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: ["https://signed.example.test/model-photo.png"],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      expect(plan.creativeIntent!.creative.addElements.some((e) => /red evening gown/i.test(e))).toBe(true);
      expect(plan.creativeIntent!.creativeBrief!.transformationRequirements.some((e) => /red evening gown/i.test(e))).toBe(true);
      expect(plan.creativeDirection.prompt).toMatch(/red evening gown/i);
    });

    it("depth-of-field transformation reaches the plan/brief/prompt (test matrix item #18)", async () => {
      const rawInstruction = "Take this photo with shallow depth of field so the background is softly blurred";
      const parsedIntent = await intent(rawInstruction, 1);
      const plan = buildStandaloneCreativeGenerationPlan({
        parsedIntent,
        uploadedReferenceImageUrls: ["https://signed.example.test/product-photo.png"],
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction,
      });

      expect(plan.creativeIntent!.creative.depthOfField).toBe("shallow depth of field, background softly blurred");
      expect(
        plan.creativeIntent!.creativeBrief!.transformationRequirements.some((e) => e === "depth of field: shallow depth of field, background softly blurred"),
      ).toBe(true);
      expect(plan.creativeDirection.prompt).toMatch(/shallow depth of field/i);
    });
  });

  describe("Shopify regression — the product path is untouched by the standalone subject/action mechanism", () => {
    it("never reads parsedIntent.subject/action's carry-forward fallback — category always comes from the real product/Product Intelligence", async () => {
      const parsedIntent = await intent("Make the product perform a somersault on a beach", 1);
      const plan = buildCreativeGenerationPlan({
        product: product(),
        intelligence: intelligence(),
        sourceMediaIds: [],
        parsedIntent,
        previousResultUrl: null,
        creativeSessionId: "session-1",
        rawInstruction: "Make the product perform a somersault on a beach",
      });

      // Category is still the real Shopify category — never overridden
      // by whatever the (inapplicable, product-context) parser produced.
      expect(plan.category).toBe("Handbags");
      expect(plan.creativeDirection.prompt).toContain("the Handbags");
      // The Shopify identity instruction remains scoped to product
      // attributes exactly as before — this pass never touched it.
      expect(plan.creativeIntent!.identityConstraints.instruction).toMatch(/shape and proportions/i);
    });
  });
});
