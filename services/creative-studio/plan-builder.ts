/**
 * Pure mapping: a synced product + its Product Intelligence profile + a
 * validated `ParsedIntent` (+ creative context/reference images/brand
 * style) → a validated `GenerationPlan` with `generationType:
 * "CREATIVE_STUDIO"`. The Creative Studio's own counterpart to
 * services/generation/build-plan.ts's `buildGenerationPlan` — deliberately
 * a SEPARATE function, not a new branch inside that one: the input shape
 * is fundamentally different (a conversational instruction + resolved
 * session context, not "a generationType + optional preset"), but the
 * OUTPUT is the exact same `GenerationPlan` shape, going through the
 * exact same `GenerationJob`/queue/worker/storage pipeline every other
 * generationType already uses — see docs/creative-studio.md
 * "Architecture" for why this satisfies "use the existing GenerationPlan
 * architecture rather than creating a second unrelated generation
 * system."
 *
 * No I/O — everything it needs is passed in already loaded, mirroring
 * build-plan.ts's own shape.
 *
 * This is the ONE place a Creative Studio prompt is synthesized — always
 * from `ParsedIntent`'s structured fields + `IdentityConstraints`, NEVER
 * from the merchant's raw message text (see docs/creative-studio.md "No
 * arbitrary prompts", the same rule build-plan.ts already enforces for
 * every other generationType).
 */
import type { ProductDetail } from "../../db/repositories/shopify-product.repository";
import type { ProductIntelligenceRow } from "../../db/repositories/product-intelligence.repository";
import { IdentityAnchorsSchema } from "../intelligence/schema";
import { parseGenerationPlan, type GenerationPlan, type BrandStylePresetAttributes } from "../generation/schema";
import { toBrandStyleContext } from "../generation/build-plan";
import type { AspectRatioValue } from "../generation/types";
import type { ParsedIntent } from "./intent-schema";
import type { CreativeIntentValue, GenerationModeValue } from "./types";
import { buildIdentityConstraints } from "./identity-constraints";

export class ProductNotAnalyzedError extends Error {
  constructor() {
    super("This product must be analyzed (Product Intelligence) before using the Creative Studio.");
    this.name = "ProductNotAnalyzedError";
  }
}

export class MissingSourceImagesError extends Error {
  constructor() {
    super("This product has no image to start from.");
    this.name = "MissingSourceImagesError";
  }
}

const DEFAULT_ASPECT_RATIO: AspectRatioValue = "1:1";

const INTENT_FRAMING: Record<CreativeIntentValue, (subject: string) => string> = {
  CREATE_LIFESTYLE: (s) => `Lifestyle product photography featuring ${s}`,
  CREATE_MARKETPLACE: (s) => `Clean, evenly lit marketplace-style product photography of ${s} on a neutral background`,
  CREATE_SOCIAL: (s) => `Eye-catching, social-media-ready product photography of ${s}`,
  CREATE_BANNER: (s) => `Promotional banner photography featuring ${s}`,
  ADD_MODEL: (s) => `Photography featuring ${s} with a model interacting with it`,
  CHANGE_MODEL: (s) => `Photography featuring ${s} with a different model`,
  EDIT_BACKGROUND: (s) => `Photography of ${s} with an updated background`,
  CHANGE_SCENE: (s) => `Photography of ${s} in an updated scene`,
  CHANGE_LIGHTING: (s) => `Photography of ${s} with adjusted lighting`,
  CHANGE_CAMERA: (s) => `Photography of ${s} shot from an adjusted camera angle`,
  CHANGE_COMPOSITION: (s) => `Photography of ${s} with adjusted composition`,
  CHANGE_PROPS: (s) => `Photography of ${s} with updated styling props`,
  CHANGE_COLOR: (s) => `Photography of ${s} with an adjusted color palette`,
  REMOVE_ELEMENT: (s) => `Photography of ${s} with an element removed`,
  ADD_ELEMENT: (s) => `Photography of ${s} with an added element`,
  UPSCALE: (s) => `A higher-resolution, sharper rendition of the existing photography of ${s}`,
  VARIATION: (s) => `An alternative version of the existing composition featuring ${s}`,
  MULTI_VARIATION: (s) => `Alternative versions of the existing composition featuring ${s}`,
  REGENERATE: (s) => `A refreshed rendition of the existing composition featuring ${s}`,
};

function synthesizeCreativePrompt(
  intent: CreativeIntentValue,
  category: string,
  creative: {
    scene: string | null;
    style: string[];
    lighting: string | null;
    composition: string | null;
    camera: string | null;
    colorDirection: string | null;
    addElements: string[];
    removeElements: string[];
  },
  identityInstruction: string,
): string {
  const subject = `the ${category}`;
  const parts = [INTENT_FRAMING[intent](subject)];

  if (creative.scene) parts.push(`placed in ${creative.scene}`);
  if (creative.style.length > 0) parts.push(`${creative.style.join(", ")} style`);
  if (creative.lighting) parts.push(creative.lighting);
  if (creative.composition) parts.push(`${creative.composition} composition`);
  if (creative.camera) parts.push(`${creative.camera} camera angle`);
  if (creative.colorDirection) parts.push(`${creative.colorDirection} color palette`);
  if (creative.addElements.length > 0) parts.push(`with ${creative.addElements.join(", ")}`);
  if (creative.removeElements.length > 0) parts.push(`without ${creative.removeElements.join(", ")}`);

  return `${parts.join(", ")}. ${identityInstruction}`;
}

export interface BuildCreativeGenerationPlanInput {
  product: ProductDetail;
  intelligence: ProductIntelligenceRow | null;
  /** The ORIGINAL Shopify-hosted product image(s) — always included for
   * identity grounding, regardless of generation mode (even an
   * IMAGE_TO_IMAGE follow-up should still ground against the true
   * original, not just the intermediate result — see
   * docs/creative-studio.md "Identity preservation"). */
  sourceMediaIds: string[];
  parsedIntent: ParsedIntent;
  /** The specific prior result being edited forward from — only present
   * for IMAGE_TO_IMAGE/IMAGE_EDIT/VARIATION modes; `null` for the
   * session's first (TEXT_TO_IMAGE) message. */
  previousResultUrl: string | null;
  brandStylePreset?: BrandStylePresetAttributes | null;
  creativeSessionId: string;
  /** The merchant's own raw message — recorded on the plan for
   * traceability ONLY (see module doc comment); never used to build
   * `creativeDirection.prompt`. */
  rawInstruction: string;
  aspectRatioOverride?: AspectRatioValue;
}

/**
 * Builds and validates a `GenerationPlan` for one Creative Studio
 * request. Throws `MissingSourceImagesError`/`ProductNotAnalyzedError` —
 * same preconditions services/generation/build-plan.ts's
 * `buildGenerationPlan` already enforces for every other generationType,
 * for the identical reason (generation without identity anchors would
 * defeat the entire point of this feature).
 */
export function buildCreativeGenerationPlan(input: BuildCreativeGenerationPlanInput): GenerationPlan {
  const { product, intelligence, sourceMediaIds, parsedIntent, previousResultUrl, brandStylePreset, creativeSessionId, rawInstruction } =
    input;

  const requestedIds = new Set(sourceMediaIds.length > 0 ? sourceMediaIds : product.media.map((m) => m.id));
  const sourceImages = product.media
    .filter((media) => requestedIds.has(media.id))
    .map((media) => ({
      mediaId: media.id,
      url: media.originalUrl,
      altText: media.altText,
      position: media.position,
    }));

  if (sourceImages.length === 0) {
    throw new MissingSourceImagesError();
  }

  if (!intelligence || intelligence.status !== "READY") {
    throw new ProductNotAnalyzedError();
  }

  const identityAnchorsResult = IdentityAnchorsSchema.safeParse(intelligence.identityAnchors);
  if (!identityAnchorsResult.success) {
    throw new ProductNotAnalyzedError();
  }
  const identityAnchors = identityAnchorsResult.data;

  const category = intelligence.category ?? (product.productType || "product");
  const identityConstraints = buildIdentityConstraints(identityAnchors, product.title);

  const creative = {
    scene: parsedIntent.scene,
    style: parsedIntent.style,
    lighting: parsedIntent.lighting,
    composition: parsedIntent.composition,
    camera: parsedIntent.camera,
    colorDirection: parsedIntent.colorDirection,
    addElements: parsedIntent.addElements,
    removeElements: parsedIntent.removeElements,
  };

  const prompt = synthesizeCreativePrompt(parsedIntent.intent, category, creative, identityConstraints.instruction);

  const referenceImages =
    previousResultUrl && (parsedIntent.mode === "IMAGE_TO_IMAGE" || parsedIntent.mode === "IMAGE_EDIT" || parsedIntent.mode === "VARIATION")
      ? [{ url: previousResultUrl, role: "previous_result" as const }]
      : [];

  const plan = {
    generationType: "CREATIVE_STUDIO" as const,
    assetType: intelligence.recommendedAssetTypes[0] ?? null,
    category,

    sourceProductId: product.id,
    sourceImages,

    productFacts: {
      identityAnchors,
    },

    creativeDirection: {
      prompt,
      negativeConstraints: [],
      environment: creative.scene,
      lighting: creative.lighting,
      composition: creative.composition,
    },

    aspectRatio: input.aspectRatioOverride ?? DEFAULT_ASPECT_RATIO,
    outputFormat: "png",
    quality: "standard",
    outputCount: parsedIntent.variationCount,

    modelConfiguration:
      intelligence.modelSuitable === null
        ? null
        : {
            modelSuitable: intelligence.modelSuitable,
            recommendedModelAttributes: intelligence.recommendedModelAttributes as Record<string, unknown> | null,
            recommendedPoseTypes: intelligence.recommendedPoseTypes,
          },

    brandStyle: brandStylePreset ? toBrandStyleContext(brandStylePreset) : null,
    lifestyleScene: null,

    creativeIntent: {
      intent: parsedIntent.intent,
      mode: parsedIntent.mode as GenerationModeValue,
      creative,
      identityConstraints,
      creativeSessionId,
      rawInstruction,
    },
    referenceImages,

    constraints: [],
  };

  return parseGenerationPlan(plan);
}
