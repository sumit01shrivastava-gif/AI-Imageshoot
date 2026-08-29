import { describe, expect, it } from "vitest";
import { buildCreativeBlueprint } from "../../../services/creative-studio/creative-blueprint";
import { DEFAULT_CAMPAIGN_ART_DIRECTION, DEFAULT_CAMPAIGN_COMMUNICATION } from "../../../services/creative-studio/intent-schema";

function blueprint(overrides: Partial<Parameters<typeof buildCreativeBlueprint>[0]> = {}) {
  return buildCreativeBlueprint({
    intent: "CREATE_SOCIAL",
    mode: "TEXT_TO_IMAGE",
    category: "Watches",
    hasProductIntelligence: true,
    isEditTurn: false,
    referenceExecutionStrategy: "CAMPAIGN_CREATIVE",
    creativeConcept: "A product-derived precision campaign world.",
    campaignArtDirection: DEFAULT_CAMPAIGN_ART_DIRECTION,
    campaignCommunication: DEFAULT_CAMPAIGN_COMMUNICATION,
    ...overrides,
  });
}

describe("Creative Blueprint — Phase 1 director contracts", () => {
  it("classifies a broad social request as a finished campaign asset while keeping product truth separate from its source scene", () => {
    const result = blueprint();

    expect(result.brief).toMatchObject({ deliverableClass: "SOCIAL_CAMPAIGN_CREATIVE", expectedFinish: "FINISHED_CAMPAIGN_ASSET" });
    expect(result.productTruth).toMatchObject({ identitySource: "REFERENCE_AND_PRODUCT_INTELLIGENCE", sourceScenePolicy: "DISCARD_FOR_CAMPAIGN" });
    expect(result.creativeDirection).toMatchObject({ campaignSceneTransformation: true, experimentation: "HIGH" });
    expect(result.commercialStrategy).toMatchObject({ objective: "PRODUCT_DESIRE", channel: "SOCIAL", compositionalPriority: "SCROLL_STOP" });
    expect(result.designDirection.assetKind).toBe("PHOTOGRAPHY_WITH_DESIGN_SPACE");
  });

  it("keeps an ecommerce product image restrained and visual-only instead of turning it into a campaign", () => {
    const result = blueprint({ intent: "CREATE_MARKETPLACE", referenceExecutionStrategy: "PRODUCT_LOCKED_RECOMPOSITION", creativeConcept: null });

    expect(result.brief.deliverableClass).toBe("ECOMMERCE_PRODUCT_IMAGE");
    expect(result.commercialStrategy).toMatchObject({ objective: "ECOMMERCE_CLARITY", channel: "ECOMMERCE", visualIntensity: "RESTRAINED" });
    expect(result.designDirection.assetKind).toBe("PHOTOGRAPHY_ONLY");
    expect(result.qualityIntent.profile).toBe("ECOMMERCE");
  });

  it("treats a product-on-model request as a distinct photography and quality concern", () => {
    const result = blueprint({ intent: "ADD_MODEL", category: "Footwear", referenceExecutionStrategy: "PRODUCT_LOCKED_RECOMPOSITION" });

    expect(result.brief.deliverableClass).toBe("PRODUCT_ON_MODEL");
    expect(result.qualityIntent).toMatchObject({ profile: "MODEL_INTERACTION" });
    expect(result.qualityIntent.priorityDimensions).toContain("PHYSICAL_INTERACTION");
    expect(result.photographyDirection.detailPriorities).toContain("seams and construction");
  });

  it("keeps an edit/continuation conservative about the requested source scene while carrying campaign DNA forward", () => {
    const result = blueprint({ intent: "CHANGE_LIGHTING", mode: "IMAGE_EDIT", isEditTurn: true, referenceExecutionStrategy: "PRECISION_EDIT" });

    expect(result.brief).toMatchObject({ deliverableClass: "PRODUCT_EDIT", expectedFinish: "EDITED_RESULT", continuation: true });
    expect(result.productTruth.sourceScenePolicy).toBe("PRESERVE_REQUESTED");
    expect(result.campaignDNA.shouldCarryForward).toBe(true);
    expect(result.conversationIntent.acknowledgementFocus).toBe("EDIT_CONTINUITY");
  });

  it("adapts an existing campaign language for a new format without turning it into a local retouch", () => {
    const original = blueprint();
    const result = blueprint({
      intent: "CREATE_BANNER",
      mode: "IMAGE_TO_IMAGE",
      isEditTurn: true,
      referenceExecutionStrategy: "CAMPAIGN_CREATIVE",
      creativeConcept: null,
      previousCampaignDNA: original.campaignDNA,
    });

    expect(result.brief).toMatchObject({ deliverableClass: "WEBSITE_BANNER", executionMode: "FORMAT_ADAPTATION" });
    expect(result.creativeDirection).toMatchObject({ conceptSource: "CAMPAIGN_DNA", concept: original.campaignDNA.governingConcept });
    expect(result.commercialStrategy).toMatchObject({ channel: "WEB", compositionalPriority: "COPY_SAFE_HIERARCHY" });
    expect(result.photographyDirection.framingPriority).toBe("WIDE_LAYOUT");
  });

  it("lets an explicit preservation edit override autonomous campaign scene replacement", () => {
    const result = blueprint({
      intent: "CHANGE_LIGHTING",
      mode: "IMAGE_EDIT",
      isEditTurn: true,
      referenceExecutionStrategy: "PRECISION_EDIT",
      creativeConcept: null,
      hasExplicitCreativeDirection: true,
    });

    expect(result.productTruth.sourceScenePolicy).toBe("PRESERVE_REQUESTED");
    expect(result.brief.executionMode).toBe("LOCAL_EDIT");
    expect(result.creativeDirection.experimentation).toBe("CONTROLLED");
  });

  it("selects category-general material priorities without a scene template or provider-specific execution", () => {
    const beauty = blueprint({ category: "Fragrance bottle" });
    const electronics = blueprint({ category: "Headphones" });

    expect(beauty.photographyDirection.realismPriorities).toContain("glass, liquid, and translucent material behavior");
    expect(electronics.photographyDirection.realismPriorities).toContain("clean reflection geometry");
    expect(beauty.generationDirection.providerBriefOrder).toEqual([
      "PRODUCT_LOCK",
      "DELIVERABLE",
      "CAMPAIGN_CONCEPT",
      "SCENE_FREEDOM",
      "ART_DIRECTION",
      "PHOTOGRAPHY",
      "DESIGN_SPACE",
      "CRITICAL_AVOIDS",
    ]);
  });

  it("keeps communication as a design decision and explicitly preserves a future deterministic compositing boundary", () => {
    const result = blueprint({
      campaignCommunication: {
        mode: "MINIMAL_CAMPAIGN_COPY",
        headline: "Made for the moment",
        supportingLine: null,
        callouts: [],
        provenance: "EVOCATIVE",
        reservedTextArea: "TOP_LEFT",
      },
    });

    expect(result.designDirection).toMatchObject({ assetKind: "FINISHED_DESIGNED_ASSET", requiresFutureDeterministicCompositing: true });
    expect(result.designDirection.communication.reservedTextArea).toBe("TOP_LEFT");
  });
});
