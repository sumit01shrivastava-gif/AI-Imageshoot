/** Provider-neutral orchestration for the existing semantic creative-planning pass. */
import type { CampaignArtDirection, CampaignCommunication } from "./intent-schema";
import type { CreativeIntentValue, GenerationModeValue } from "./types";

export type DeliverableClass = "ECOMMERCE_PRODUCT_IMAGE" | "SOCIAL_CAMPAIGN_CREATIVE" | "WEBSITE_BANNER" | "LIFESTYLE_PRODUCT_PHOTOGRAPH" | "PRODUCT_ON_MODEL" | "PRODUCT_EDIT" | "CAMPAIGN_VARIATION" | "PREMIUM_PRODUCT_PHOTOGRAPH";
type DesignAssetKind = "PHOTOGRAPHY_ONLY" | "PHOTOGRAPHY_WITH_DESIGN_SPACE" | "FINISHED_DESIGNED_ASSET";

/**
 * Canonical, provider-modality-independent execution strategy for a
 * reference product image. `mode`/`isEditTurn` (services/ai/types.ts's
 * `GenerationMode`) describe WHICH PROVIDER CALL shape a request uses
 * (plain generation vs. image-conditioned edit) — they are never, by
 * themselves, evidence of what the merchant wants done with the
 * referenced product's SURROUNDING SCENE. Conflating the two was a real,
 * confirmed production bug: uploading a product reference made
 * `isEditTurn` true even on a request's first turn, which previously
 * forced every downstream campaign decision (source-scene policy,
 * execution mode, Quality Director profile, conversational
 * acknowledgement) into precision-edit semantics for a request like
 * "create a social media creative for this product" — producing a
 * technically accurate product photo with contradictory "preserve the
 * exact starting point" language baked into the same provider brief as
 * "SOCIAL CAMPAIGN CREATIVE."
 *
 *   - PRECISION_EDIT — the merchant wants the existing composition
 *     modified (remove/replace one element, relight, recolor, ...).
 *     Preserve product AND scene except what's explicitly requested.
 *   - PRODUCT_LOCKED_RECOMPOSITION — the reference is PRODUCT TRUTH, not
 *     the creative canvas. Product identity stays locked; the source
 *     environment/composition/framing/props/lighting are all
 *     replaceable (a merchant-directed new scene, e.g. "put this watch
 *     on black marble," still fits here — the product is locked, the
 *     scene is whatever was asked for, never autonomously reinvented).
 *   - CAMPAIGN_CREATIVE — the reference is PRODUCT TRUTH, not the
 *     creative canvas, and the Creative Director has full authority over
 *     environment, composition, framing, lighting, props, and campaign
 *     design — a channel deliverable (social/banner), not a photograph
 *     of the product in its current setting.
 *
 * See docs/creative-studio.md "Reference execution strategy" for the
 * full worked examples this classification is built from.
 */
export type ReferenceExecutionStrategy = "PRECISION_EDIT" | "PRODUCT_LOCKED_RECOMPOSITION" | "CAMPAIGN_CREATIVE";

export type CreativeBlueprint = {
  referenceExecutionStrategy: ReferenceExecutionStrategy;
  brief: { deliverableClass: DeliverableClass; transformationFreedom: "NONE" | "LIMITED" | "HIGH"; expectedFinish: "PRODUCT_PHOTOGRAPH" | "FINISHED_CAMPAIGN_ASSET" | "EDITED_RESULT"; executionMode: "NEW_CREATION" | "CONTINUATION" | "LOCAL_EDIT" | "FORMAT_ADAPTATION"; continuation: boolean };
  productTruth: { identitySource: "REFERENCE_AND_PRODUCT_INTELLIGENCE" | "REFERENCE_ONLY" | "PRODUCT_INTELLIGENCE"; sourceScenePolicy: "PRESERVE_REQUESTED" | "REPLACEABLE" | "DISCARD_FOR_CAMPAIGN"; categoryFocus: string[] };
  commercialStrategy: { objective: "ECOMMERCE_CLARITY" | "PRODUCT_DESIRE" | "BRAND_COMMUNICATION" | "LIFESTYLE_RELEVANCE" | "REFINEMENT"; channel: "ECOMMERCE" | "SOCIAL" | "WEB" | "GENERAL"; visualIntensity: "RESTRAINED" | "ELEVATED" | "HIGH"; compositionalPriority: "INSPECTABILITY" | "SCROLL_STOP" | "COPY_SAFE_HIERARCHY" | "CONTEXTUAL_RELEVANCE" };
  creativeDirection: { concept: string | null; conceptSource: "SEMANTIC_PLANNING" | "CAMPAIGN_DNA" | "RESTRAINED_FALLBACK"; campaignSceneTransformation: boolean; experimentation: "CONTROLLED" | "HIGH" };
  artDirection: CampaignArtDirection;
  photographyDirection: { category: string | null; detailPriorities: string[]; realismPriorities: string[]; framingPriority: "PRODUCT_INSPECTION" | "PRODUCT_IN_WORLD" | "MOBILE_HIERARCHY" | "WIDE_LAYOUT" };
  designDirection: { assetKind: DesignAssetKind; communication: CampaignCommunication; requiresFutureDeterministicCompositing: boolean };
  generationDirection: { providerBriefOrder: Array<"PRODUCT_LOCK" | "DELIVERABLE" | "CAMPAIGN_CONCEPT" | "SCENE_FREEDOM" | "ART_DIRECTION" | "PHOTOGRAPHY" | "DESIGN_SPACE" | "CRITICAL_AVOIDS"> };
  qualityIntent: { profile: "ECOMMERCE" | "CAMPAIGN" | "MODEL_INTERACTION" | "EDIT"; priorityDimensions: string[] };
  conversationIntent: { acknowledgementFocus: "PRODUCT_FIDELITY" | "CAMPAIGN_TRANSFORMATION" | "EDIT_CONTINUITY"; suggestContinuation: boolean };
  campaignDNA: { shouldCarryForward: boolean; carryForwardFields: Array<"CONCEPT" | "ART_DIRECTION" | "PHOTOGRAPHY" | "DESIGN_DIRECTION">; governingConcept: string | null; artDirection: CampaignArtDirection; photographyCharacter: string[]; designAssetKind: DesignAssetKind };
};

export type PreviousCampaignDNA = CreativeBlueprint["campaignDNA"];

/** Intents that are, by their own nature, a targeted modification of an
 * existing composition — explicit precision-edit language always
 * resolves to one of these (see services/ai/heuristic-intent-parser.ts's
 * `classifyIntent`), so intent alone is sufficient signal; no separate
 * "did the merchant use edit language" check is needed on top of it.
 * Always PRECISION_EDIT, regardless of campaign continuation — a
 * targeted "remove the small object on the left" on a campaign result is
 * still a precision edit of that result, not a new campaign turn. */
const HARD_PRECISION_EDIT_INTENTS: ReadonlySet<CreativeIntentValue> = new Set([
  "EDIT_BACKGROUND",
  "CHANGE_LIGHTING",
  "CHANGE_CAMERA",
  "CHANGE_PROPS",
  "CHANGE_COLOR",
  "REMOVE_ELEMENT",
  "ADD_ELEMENT",
  "UPSCALE",
]);

/** Channel deliverables — an explicit request for autonomous campaign
 * invention, not a photograph of the product as currently presented. */
const CAMPAIGN_DELIVERABLE_INTENTS: ReadonlySet<CreativeIntentValue> = new Set(["CREATE_SOCIAL", "CREATE_BANNER"]);

/** Ambiguous "adapt/repeat the current result" intents — these describe
 * HOW MANY/WHAT FORMAT, not a creative direction of their own, so their
 * strategy is inherited from whatever produced the result they're
 * adapting: a campaign's own variation stays a campaign ("make it
 * vertical" on a social creative), a plain product photo's variation
 * stays a precision-style regeneration. */
const CONTINUATION_INTENTS: ReadonlySet<CreativeIntentValue> = new Set(["VARIATION", "MULTI_VARIATION", "REGENERATE", "CHANGE_COMPOSITION"]);

/** Intents that legitimately want a new/directed scene while keeping the
 * product locked, without requesting full autonomous campaign invention. */
const RECOMPOSITION_INTENTS: ReadonlySet<CreativeIntentValue> = new Set(["CREATE_LIFESTYLE", "CREATE_MARKETPLACE", "CHANGE_SCENE", "ADD_MODEL", "CHANGE_MODEL"]);

/**
 * INTENT-FIRST classification — deliberately takes no `mode`/`isEditTurn`
 * parameter at all, so a provider-modality detail can never determine
 * creative strategy (see `ReferenceExecutionStrategy`'s own doc
 * comment). `hasExplicitScene` is the one legitimate override: a
 * merchant who named a specific environment/composition is directing
 * the shot, which downgrades even a channel deliverable out of
 * autonomous campaign-world invention into a locked recomposition of
 * exactly what was asked for — never silently overridden by the
 * Creative Director's own judgment (see CLAUDE.md's "explicit beats
 * inferred" rule, applied here to campaign scope the same way it already
 * applies to color/material overrides).
 */
export function classifyReferenceExecutionStrategy(
  intent: CreativeIntentValue,
  hasExplicitScene: boolean,
  previousCampaignDNA?: PreviousCampaignDNA | null,
): ReferenceExecutionStrategy {
  if (HARD_PRECISION_EDIT_INTENTS.has(intent)) return "PRECISION_EDIT";
  if (CAMPAIGN_DELIVERABLE_INTENTS.has(intent)) {
    return hasExplicitScene ? "PRODUCT_LOCKED_RECOMPOSITION" : "CAMPAIGN_CREATIVE";
  }
  if (CONTINUATION_INTENTS.has(intent)) {
    return previousCampaignDNA?.shouldCarryForward ? "CAMPAIGN_CREATIVE" : "PRECISION_EDIT";
  }
  if (RECOMPOSITION_INTENTS.has(intent)) return "PRODUCT_LOCKED_RECOMPOSITION";
  return "PRODUCT_LOCKED_RECOMPOSITION";
}

/** Whether a request adapts an EXISTING finished campaign asset into a
 * new format/channel (e.g. "make it vertical", "create a banner" as a
 * follow-up to an already-produced social creative) rather than starting
 * a campaign fresh. Requires both a genuine prior campaign to adapt
 * (`previousCampaignDNA.shouldCarryForward`) AND an actual reference to
 * adapt from (`isEditTurn`) — a first-ever "create a social media
 * creative for this product" turn has neither, so it is never mistaken
 * for reformatting a campaign that doesn't exist yet (the exact
 * production bug this file fixes). */
function isCampaignFormatAdaptation(intent: CreativeIntentValue, isEditTurn: boolean, previousCampaignDNA?: PreviousCampaignDNA | null): boolean {
  return (
    (CONTINUATION_INTENTS.has(intent) || CAMPAIGN_DELIVERABLE_INTENTS.has(intent)) && isEditTurn && Boolean(previousCampaignDNA?.shouldCarryForward)
  );
}

export interface BuildCreativeBlueprintInput {
  intent: CreativeIntentValue; mode: GenerationModeValue; category: string | null; hasProductIntelligence: boolean; isEditTurn: boolean; referenceExecutionStrategy: ReferenceExecutionStrategy; creativeConcept: string | null; campaignArtDirection: CampaignArtDirection; campaignCommunication: CampaignCommunication; previousCampaignDNA?: PreviousCampaignDNA | null; hasExplicitCreativeDirection?: boolean;
}

function classifyDeliverable(intent: CreativeIntentValue, isEditTurn: boolean): DeliverableClass {
  if (intent === "CREATE_MARKETPLACE") return "ECOMMERCE_PRODUCT_IMAGE";
  if (intent === "CREATE_SOCIAL") return "SOCIAL_CAMPAIGN_CREATIVE";
  if (intent === "CREATE_BANNER") return "WEBSITE_BANNER";
  if (intent === "CREATE_LIFESTYLE") return "LIFESTYLE_PRODUCT_PHOTOGRAPH";
  if (intent === "ADD_MODEL" || intent === "CHANGE_MODEL") return "PRODUCT_ON_MODEL";
  if (intent === "VARIATION" || intent === "MULTI_VARIATION" || intent === "REGENERATE") return "CAMPAIGN_VARIATION";
  return isEditTurn ? "PRODUCT_EDIT" : "PREMIUM_PRODUCT_PHOTOGRAPH";
}
function photographyPriorities(category: string | null) {
  const text = category?.toLowerCase() ?? "";
  if (/watch|jewel|ring|necklace|bracelet/.test(text)) return { detail: ["fine geometry", "markings, settings, and articulated components", "metal edge definition"], realism: ["controlled specular reflections", "crystal or gemstone readability", "accurate scale and contact"] };
  if (/beauty|cosmetic|skin|perfume|fragrance|bottle/.test(text)) return { detail: ["packaging geometry", "label fidelity", "cap or pump detail"], realism: ["glass, liquid, and translucent material behavior", "gloss control", "clean edge separation"] };
  if (/apparel|fashion|shoe|sneaker|footwear|bag|handbag/.test(text)) return { detail: ["silhouette", "seams and construction", "material texture"], realism: ["fabric or leather texture", "grounded scale", "believable contact and drape"] };
  if (/device|electronic|phone|computer|headphone/.test(text)) return { detail: ["controls and interfaces", "edge geometry", "surface finish"], realism: ["clean reflection geometry", "precise perspective", "material separation"] };
  if (/food|beverage|drink|coffee|tea|snack/.test(text)) return { detail: ["package or product silhouette", "label readability", "surface texture"], realism: ["appetizing texture", "credible liquid or condensation behavior", "natural scale and contact"] };
  return { detail: ["recognizable silhouette", "distinctive construction", "surface detail"], realism: ["physically plausible lighting", "contact shadows", "material-specific reflections"] };
}
function hasArtDirection(art: CampaignArtDirection) { return Object.values(art).some(Boolean); }
function resolveArtDirection(input: BuildCreativeBlueprintInput, campaign: boolean, ecommerce: boolean): CampaignArtDirection {
  if (hasArtDirection(input.campaignArtDirection)) return input.campaignArtDirection;
  if (input.previousCampaignDNA?.shouldCarryForward && !input.hasExplicitCreativeDirection) return input.previousCampaignDNA.artDirection;
  if (ecommerce) return { visualStory: "A clear, accurate product presentation.", heroTreatment: "Keep the product fully inspectable with restrained hierarchy.", canvasArchitecture: "Use a clean field with no competing props or copy.", productEnvironmentRelationship: "The environment supports product readability rather than becoming a concept.", materialLightingStrategy: "Use even, truthful light that preserves material color, edges, and labels." };
  if (campaign) return { visualStory: "Build one product-derived commercial world rather than decorating the source photograph.", heroTreatment: "Keep the product unmistakable while giving the campaign world meaningful visual territory.", canvasArchitecture: "Use deliberate hierarchy, depth, and negative space appropriate to the deliverable.", productEnvironmentRelationship: "Make the surroundings express the product's material, form, and commercial character.", materialLightingStrategy: "Use controlled, physically plausible light that reveals the product's defining materials." };
  return { visualStory: null, heroTreatment: null, canvasArchitecture: null, productEnvironmentRelationship: null, materialLightingStrategy: null };
}
function resolveDesignAsset(deliverable: DeliverableClass, communication: CampaignCommunication): DesignAssetKind {
  if (communication.mode !== "VISUAL_ONLY") return "FINISHED_DESIGNED_ASSET";
  return deliverable === "SOCIAL_CAMPAIGN_CREATIVE" || deliverable === "WEBSITE_BANNER" ? "PHOTOGRAPHY_WITH_DESIGN_SPACE" : "PHOTOGRAPHY_ONLY";
}

export function buildCreativeBlueprint(input: BuildCreativeBlueprintInput): CreativeBlueprint {
  const deliverableClass = classifyDeliverable(input.intent, input.isEditTurn);
  const ecommerce = deliverableClass === "ECOMMERCE_PRODUCT_IMAGE";
  const modelInteraction = deliverableClass === "PRODUCT_ON_MODEL";
  // The canonical, INTENT-FIRST strategy — never `input.isEditTurn`/mode
  // — is the single source of truth every branch below reads from. See
  // `ReferenceExecutionStrategy`'s own doc comment for why this
  // replaced a scattered set of `input.isEditTurn` checks that each
  // independently (and inconsistently) tried to answer the same
  // question.
  const campaign = input.referenceExecutionStrategy === "CAMPAIGN_CREATIVE";
  const photo = photographyPriorities(input.category);
  const artDirection = resolveArtDirection(input, campaign, ecommerce);
  const concept = input.creativeConcept ?? (input.previousCampaignDNA?.shouldCarryForward && !input.hasExplicitCreativeDirection ? input.previousCampaignDNA.governingConcept : null);
  const assetKind = resolveDesignAsset(deliverableClass, input.campaignCommunication);
  const formatAdaptation = isCampaignFormatAdaptation(input.intent, input.isEditTurn, input.previousCampaignDNA);
  const executionMode =
    input.referenceExecutionStrategy === "PRECISION_EDIT"
      ? input.isEditTurn
        ? "LOCAL_EDIT"
        : "NEW_CREATION"
      : formatAdaptation
        ? "FORMAT_ADAPTATION"
        : input.mode !== "TEXT_TO_IMAGE" || deliverableClass === "CAMPAIGN_VARIATION"
          ? "CONTINUATION"
          : "NEW_CREATION";
  const objective = ecommerce ? "ECOMMERCE_CLARITY" : campaign ? "PRODUCT_DESIRE" : modelInteraction ? "LIFESTYLE_RELEVANCE" : input.referenceExecutionStrategy === "PRECISION_EDIT" ? "REFINEMENT" : "BRAND_COMMUNICATION";
  const channel = deliverableClass === "SOCIAL_CAMPAIGN_CREATIVE" ? "SOCIAL" : deliverableClass === "WEBSITE_BANNER" ? "WEB" : ecommerce ? "ECOMMERCE" : "GENERAL";
  const compositionalPriority = ecommerce ? "INSPECTABILITY" : channel === "SOCIAL" ? "SCROLL_STOP" : channel === "WEB" ? "COPY_SAFE_HIERARCHY" : modelInteraction ? "CONTEXTUAL_RELEVANCE" : "INSPECTABILITY";
  const framingPriority = ecommerce ? "PRODUCT_INSPECTION" : channel === "SOCIAL" ? "MOBILE_HIERARCHY" : channel === "WEB" ? "WIDE_LAYOUT" : campaign ? "PRODUCT_IN_WORLD" : "PRODUCT_INSPECTION";
  const shouldCarryForward = campaign || input.isEditTurn || Boolean(input.previousCampaignDNA?.shouldCarryForward);
  return {
    referenceExecutionStrategy: input.referenceExecutionStrategy,
    brief: { deliverableClass, transformationFreedom: campaign ? "HIGH" : "LIMITED", expectedFinish: assetKind === "FINISHED_DESIGNED_ASSET" || campaign ? "FINISHED_CAMPAIGN_ASSET" : input.isEditTurn ? "EDITED_RESULT" : "PRODUCT_PHOTOGRAPH", executionMode, continuation: input.isEditTurn || input.mode !== "TEXT_TO_IMAGE" },
    productTruth: {
      identitySource: input.hasProductIntelligence ? "REFERENCE_AND_PRODUCT_INTELLIGENCE" : "REFERENCE_ONLY",
      // Fully derived from the canonical strategy — never `isEditTurn` —
      // so a reference image's mere presence can never leave the source
      // scene locked for a campaign deliverable (the exact production
      // bug this fixes). PRODUCT_LOCKED_RECOMPOSITION always resolves to
      // REPLACEABLE: the product stays locked, but the scene is never
      // assumed to be "preserve what's there" just because a reference
      // exists.
      sourceScenePolicy:
        input.referenceExecutionStrategy === "CAMPAIGN_CREATIVE"
          ? "DISCARD_FOR_CAMPAIGN"
          : input.referenceExecutionStrategy === "PRECISION_EDIT"
            ? "PRESERVE_REQUESTED"
            : "REPLACEABLE",
      categoryFocus: photo.detail,
    },
    commercialStrategy: { objective, channel, visualIntensity: ecommerce ? "RESTRAINED" : campaign ? "HIGH" : "ELEVATED", compositionalPriority },
    creativeDirection: { concept, conceptSource: input.creativeConcept ? "SEMANTIC_PLANNING" : concept ? "CAMPAIGN_DNA" : "RESTRAINED_FALLBACK", campaignSceneTransformation: campaign, experimentation: campaign ? "HIGH" : "CONTROLLED" },
    artDirection,
    photographyDirection: { category: input.category, detailPriorities: photo.detail, realismPriorities: photo.realism, framingPriority },
    designDirection: { assetKind, communication: input.campaignCommunication, requiresFutureDeterministicCompositing: assetKind === "FINISHED_DESIGNED_ASSET" },
    generationDirection: { providerBriefOrder: ["PRODUCT_LOCK", "DELIVERABLE", "CAMPAIGN_CONCEPT", "SCENE_FREEDOM", "ART_DIRECTION", "PHOTOGRAPHY", "DESIGN_SPACE", "CRITICAL_AVOIDS"] },
    // Deliverable/strategy-first, exactly as CLAUDE.md's Quality Director
    // profile-selection rule requires — CREATE_SOCIAL/CREATE_BANNER must
    // never fall back to the EDIT profile merely because a reference
    // image exists (the exact production bug this fixes: a reference
    // upload made `isEditTurn` true, which previously selected EDIT for
    // every campaign request that had one).
    qualityIntent: { profile: ecommerce ? "ECOMMERCE" : modelInteraction ? "MODEL_INTERACTION" : input.referenceExecutionStrategy === "PRECISION_EDIT" ? "EDIT" : "CAMPAIGN", priorityDimensions: ecommerce ? ["PRODUCT_FIDELITY", "COMPOSITION", "COMMERCIAL_USEFULNESS"] : modelInteraction ? ["PRODUCT_FIDELITY", "PHYSICAL_INTERACTION", "ANATOMY", "PHOTOGRAPHIC_REALISM"] : ["PRODUCT_FIDELITY", "BRIEF_FIDELITY", "CREATIVE_QUALITY", "ART_DIRECTION", "COMMERCIAL_USEFULNESS"] },
    conversationIntent: { acknowledgementFocus: campaign ? "CAMPAIGN_TRANSFORMATION" : input.referenceExecutionStrategy === "PRECISION_EDIT" ? "EDIT_CONTINUITY" : "PRODUCT_FIDELITY", suggestContinuation: true },
    campaignDNA: { shouldCarryForward, carryForwardFields: campaign ? ["CONCEPT", "ART_DIRECTION", "PHOTOGRAPHY", "DESIGN_DIRECTION"] : ["PHOTOGRAPHY"], governingConcept: concept, artDirection, photographyCharacter: [...photo.detail, ...photo.realism], designAssetKind: assetKind },
  };
}

/** Compiles resolved decisions only; internal taxonomy/reasoning never reaches a provider. */
export function compileProviderExecutionBrief(input: { blueprint: CreativeBlueprint; primaryTask: string; identityInstruction: string; referenceInstruction: string | null; explicitDirection: string[]; negativeConstraints: string[] }): string {
  const { blueprint, primaryTask, identityInstruction, referenceInstruction, explicitDirection, negativeConstraints } = input;
  const art = blueprint.artDirection;
  return [
    identityInstruction, referenceInstruction, `DELIVERABLE: ${blueprint.brief.deliverableClass.toLowerCase().replace(/_/g, " ")}.`,
    blueprint.creativeDirection.concept ? `SELECTED CAMPAIGN PROPOSITION: ${blueprint.creativeDirection.concept}.` : null,
    `MERCHANT DIRECTION: ${primaryTask}.`,
    blueprint.productTruth.sourceScenePolicy === "DISCARD_FOR_CAMPAIGN" ? "SCENE: Preserve the physical product only; replace incidental source scenery with a new product-derived commercial world." : null,
    art.visualStory ? `VISUAL STORY: ${art.visualStory} HERO TREATMENT: ${art.heroTreatment ?? ""} CANVAS ARCHITECTURE: ${art.canvasArchitecture ?? ""} PRODUCT-WORLD RELATIONSHIP: ${art.productEnvironmentRelationship ?? ""}`.trim() : null,
    `PHOTOGRAPHY: Prioritize ${blueprint.photographyDirection.detailPriorities.slice(0, 3).join(", ")}; use ${blueprint.photographyDirection.realismPriorities.slice(0, 3).join(", ")}.`,
    blueprint.designDirection.assetKind === "PHOTOGRAPHY_ONLY" ? "DESIGN: Keep the result visual-first; do not add campaign copy, unrequested text, branding, claims, labels, or badges." : null,
    blueprint.designDirection.assetKind === "PHOTOGRAPHY_WITH_DESIGN_SPACE" ? "DESIGN: Reserve clean negative space for channel layout; keep the image visual-first without unrequested text." : null,
    blueprint.designDirection.assetKind === "FINISHED_DESIGNED_ASSET" ? `DESIGN: Use only approved ${blueprint.designDirection.communication.mode === "FACTUAL_CALLOUTS" ? "merchant-supplied" : "campaign"} copy in the ${blueprint.designDirection.communication.reservedTextArea.toLowerCase().replace(/_/g, " ")} region: ${[blueprint.designDirection.communication.headline, blueprint.designDirection.communication.supportingLine, ...blueprint.designDirection.communication.callouts].filter(Boolean).map((copy) => `“${copy}”`).join("; ")}. Do not add unapproved copy, branding, claims, or badges.` : null,
    explicitDirection.length > 0 ? `EXECUTION PRIORITIES: As the creative director, ensure: ${explicitDirection.join("; ")}.` : null,
    negativeConstraints.length > 0 ? `AVOID: ${negativeConstraints.slice(0, 3).join("; ")}.` : null,
  ].filter((section): section is string => Boolean(section)).join(" ");
}
