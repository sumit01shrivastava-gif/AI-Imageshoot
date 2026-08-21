/**
 * Pure mapping: a synced product + its Product Intelligence profile (+ the
 * merchant's chosen source images and generation type) → a validated
 * `GenerationPlan`. No I/O — everything it needs is passed in already
 * loaded, mirroring services/intelligence/build-input.ts's shape.
 *
 * This is the ONLY place a generation prompt is synthesized. It is always
 * built from structured fields (category/material/color/style/
 * environment/...), never from merchant-typed free text — see
 * docs/generation.md "No arbitrary prompts".
 */
import type { ProductDetail } from "../../db/repositories/shopify-product.repository";
import type { ProductIntelligenceRow } from "../../db/repositories/product-intelligence.repository";
import { IdentityAnchorsSchema } from "../intelligence/schema";
import { parseGenerationPlan, type GenerationPlan, type BrandStylePresetAttributes, type LifestyleScene } from "./schema";
import { buildLifestyleScene, type LifestyleSceneOverride } from "./lifestyle-scene";
import type { GenerationTypeValue, AspectRatioValue } from "./types";

const GENERATION_TYPE_LABEL: Record<GenerationTypeValue, string> = {
  PRODUCT_CLEANUP: "Clean product",
  BACKGROUND_REMOVAL: "Background-removed product",
  BACKGROUND_REPLACEMENT: "Background-replaced product",
  LIFESTYLE: "Lifestyle",
  MODEL_SHOOT: "Model",
  BANNER: "Banner",
  CATEGORY_BANNER: "Category banner",
  CTA: "Call-to-action",
  CAMPAIGN: "Campaign",
  // Never actually reached — build-plan.ts's `buildGenerationPlan` isn't
  // used for CREATIVE_STUDIO requests (see
  // services/creative-studio/plan-builder.ts's own, separate plan
  // builder); kept here only so this lookup table stays a total
  // function over every GenerationType value.
  CREATIVE_STUDIO: "Creative Studio",
};

const DEFAULT_ASPECT_RATIO: AspectRatioValue = "1:1";

/** Per-generationType default aspect ratio, used only when the caller
 * doesn't supply an `aspectRatioOverride` — e.g. BANNER benefits from a
 * wide hero-style default; everything else keeps the original "1:1"
 * default ("Generate Test Image"'s long-standing behavior, unchanged). */
const DEFAULT_ASPECT_RATIO_BY_TYPE: Partial<Record<GenerationTypeValue, AspectRatioValue>> = {
  BANNER: "21:9",
};

/** generationTypes a `BrandStylePreset` actually applies to — every
 * "creative placement" type. PRODUCT_CLEANUP/BACKGROUND_REMOVAL/
 * BACKGROUND_REPLACEMENT stay preset-free (they're deterministic-feeling
 * cleanup, not a styled composition); CATEGORY_BANNER/CAMPAIGN aren't
 * implemented yet (see docs/lifestyle-generation.md "Deferred"). */
const PRESET_APPLICABLE_TYPES: ReadonlySet<GenerationTypeValue> = new Set([
  "LIFESTYLE",
  "MODEL_SHOOT",
  "BANNER",
  "CTA",
]);

export interface BuildGenerationPlanInput {
  product: ProductDetail;
  intelligence: ProductIntelligenceRow | null;
  sourceMediaIds: string[];
  generationType: GenerationTypeValue;
  /**
   * Structured creative-direction overrides. NOT wired to any route this
   * phase — see docs/generation.md "No arbitrary prompts": the
   * merchant-facing action never passes this. Exists so a later phase's
   * UI (or a test exercising the deterministic provider's forced-failure
   * hook — see deterministic-test-provider.server.ts) can supply it
   * without a signature change.
   */
  visualDirectionOverride?: {
    environment?: string | null;
    lighting?: string | null;
    composition?: string | null;
    /** Structured, machine-checkable constraints — e.g. the deterministic
     * test provider's forced-failure markers (see
     * deterministic-test-provider.server.ts). Not wired to any route. */
    negativeConstraints?: string[];
  };
  /** How many outputs to request — not wired to any route (the minimal
   * "Generate Test Image" button always requests exactly one); exists so
   * tests can exercise multi-result storage/persistence through the real
   * pipeline. Defaults to 1. */
  outputCountOverride?: number;
  /**
   * LIFESTYLE/MODEL_SHOOT/BANNER/CTA only (see `PRESET_APPLICABLE_TYPES`)
   * — the resolved brand style preset (built-in or shop-owned custom;
   * resolution happens in services/generation/brand-style-preset.server.ts,
   * one layer up — this function stays pure/no I/O). `null`/omitted means
   * "no preset chosen," which still produces a fully-formed scene via
   * category-aware defaults (services/generation/lifestyle-scene.ts never
   * requires a preset, for LIFESTYLE). Ignored for every other
   * generationType.
   */
  brandStylePreset?: { id: string; name: string; attributes: BrandStylePresetAttributes } | null;
  /** LIFESTYLE only — structured merchant scene-control overrides (never
   * a free-text prompt — see docs/generation.md "No arbitrary prompts").
   * Ignored for every other generationType. */
  lifestyleSceneOverride?: LifestyleSceneOverride;
  /** A curated aspect ratio (see types.ts's `ASPECT_RATIOS`) — applies to
   * every generationType. Defaults to `DEFAULT_ASPECT_RATIO` when omitted
   * (the original "Generate Test Image" button's behavior, unchanged). */
  aspectRatioOverride?: AspectRatioValue;
}

export class MissingSourceImagesError extends Error {
  constructor() {
    super("At least one source image must be selected for generation.");
    this.name = "MissingSourceImagesError";
  }
}

export class ProductNotAnalyzedError extends Error {
  constructor() {
    super("This product must be analyzed (Product Intelligence) before generating images.");
    this.name = "ProductNotAnalyzedError";
  }
}

/** MODEL_SHOOT only — thrown when Product Intelligence has determined this
 * product isn't model-suitable (`modelSuitable !== true`; see
 * services/intelligence/category-recommendations.ts — furniture/
 * appliances/electronics/food are never model-suitable). Mirrors
 * `ProductNotAnalyzedError`'s "require the precondition, don't silently
 * generate something meaningless" reasoning. */
export class ProductNotModelSuitableError extends Error {
  constructor() {
    super("This product isn't suited for model imagery (see its Product Intelligence profile).");
    this.name = "ProductNotModelSuitableError";
  }
}

// Identity-preservation instruction appended to every synthesized prompt
// that places the product somewhere new (i.e. not the plain studio
// cleanup case, which already states this itself) — see
// docs/generation.md "Identity preservation" / docs/lifestyle-generation.md.
const PRESERVE_PRODUCT_INSTRUCTION =
  "Preserve the product exactly as shown in the source image — do not alter its shape, material, color, or any visible branding.";

function synthesizePrompt(input: {
  generationType: GenerationTypeValue;
  category: string;
  material: string | null;
  primaryColor: string | null;
  style: string | null;
  environment: string | null;
  photographyStyle: string | null;
  scene?: LifestyleScene;
  /** MODEL_SHOOT only. */
  pose?: string | null;
  modelStyle?: string | null;
  /** BANNER/CTA only — a resolved brand style preset's own attributes,
   * used directly (no LIFESTYLE-style scene/category resolution — a
   * banner's composition is simpler: subject + backdrop + mood, not a
   * full placed-in-a-scene concept). */
  backgroundStyle?: string | null;
  compositionStyle?: string | null;
  mood?: string | null;
}): string {
  const descriptor = [input.primaryColor, input.material, input.category].filter(Boolean).join(" ").trim();
  const subject = descriptor || "product";

  if (input.generationType === "PRODUCT_CLEANUP") {
    return (
      `Clean, evenly lit product photography of the ${subject}. ${PRESERVE_PRODUCT_INSTRUCTION} ` +
      `Neutral, distraction-free background.`
    );
  }

  if (input.generationType === "LIFESTYLE") {
    const parts = [`Lifestyle product photography of the ${subject}`];
    if (input.environment) parts.push(`placed in ${input.environment}`);
    if (input.scene?.surface) parts.push(`resting on ${input.scene.surface}`);
    if (input.scene?.props && input.scene.props.length > 0) parts.push(`styled with ${input.scene.props.join(", ")}`);
    if (input.scene?.camera) parts.push(`${input.scene.camera} camera angle`);
    if (input.photographyStyle) parts.push(`${input.photographyStyle} photography style`);
    if (input.scene?.mood) parts.push(`${input.scene.mood} mood`);
    if (input.scene?.colorDirection) parts.push(`${input.scene.colorDirection} color palette`);
    return `${parts.join(", ")}. ${PRESERVE_PRODUCT_INSTRUCTION}`;
  }

  if (input.generationType === "MODEL_SHOOT") {
    // Deliberately generic ("featuring", not "worn by") — modelSuitable is
    // true for a range of categories (jewelry, eyewear, handbags, shoes,
    // clothing — see category-recommendations.ts), not all of which are
    // literally "worn" the same way.
    const parts = [`Model photography featuring the ${subject}`];
    if (input.pose) parts.push(`${input.pose} pose`);
    if (input.environment) parts.push(`set in ${input.environment}`);
    if (input.modelStyle) parts.push(`${input.modelStyle} model styling`);
    if (input.photographyStyle) parts.push(`${input.photographyStyle} photography style`);
    return `${parts.join(", ")}. ${PRESERVE_PRODUCT_INSTRUCTION}`;
  }

  if (input.generationType === "BANNER") {
    const parts = [`Promotional banner photography featuring the ${subject}`];
    if (input.backgroundStyle) parts.push(`${input.backgroundStyle} backdrop`);
    else if (input.environment) parts.push(`set in ${input.environment}`);
    if (input.compositionStyle) parts.push(`${input.compositionStyle} composition`);
    parts.push("composed with clear open space for text overlay");
    if (input.photographyStyle) parts.push(`${input.photographyStyle} photography style`);
    if (input.mood) parts.push(`${input.mood} mood`);
    return `${parts.join(", ")}. ${PRESERVE_PRODUCT_INSTRUCTION} Do not render any text, logos, or typography.`;
  }

  if (input.generationType === "CTA") {
    const parts = [`Bold, attention-grabbing call-to-action imagery featuring the ${subject}`];
    if (input.backgroundStyle) parts.push(`${input.backgroundStyle} backdrop`);
    else if (input.environment) parts.push(`set in ${input.environment}`);
    if (input.photographyStyle) parts.push(`${input.photographyStyle} photography style`);
    if (input.mood) parts.push(`${input.mood} mood`);
    return `${parts.join(", ")}. ${PRESERVE_PRODUCT_INSTRUCTION} Do not render any text, logos, or typography.`;
  }

  const parts = [`${GENERATION_TYPE_LABEL[input.generationType]} photography of the ${subject}`];
  if (input.style) parts.push(`${input.style} style`);
  if (input.environment) parts.push(`set in ${input.environment}`);
  if (input.photographyStyle) parts.push(`${input.photographyStyle} photography style`);
  return `${parts.join(", ")}.`;
}

// The subset of BrandStylePresetAttributes that GenerateImageInput.brandStyle
// (BrandStyleContextSchema) actually accepts — see that schema's own doc
// comment for why BrandStylePresetAttributesSchema is deliberately a
// superset (it also carries scene defaults BrandStyleContext doesn't).
// Exported for services/creative-studio/plan-builder.ts's reuse — the
// Creative Studio applies the SAME brand style presets LIFESTYLE/
// MODEL_SHOOT/BANNER/CTA already do, not a separate preset concept.
export function toBrandStyleContext(attributes: BrandStylePresetAttributes) {
  const { visualTone, colorPalette, photographyStyle, backgroundStyle, lightingStyle, compositionStyle, luxuryLevel, modelStyle } =
    attributes;
  const context = { visualTone, colorPalette, photographyStyle, backgroundStyle, lightingStyle, compositionStyle, luxuryLevel, modelStyle };
  const hasAnyField = Object.values(context).some((value) => value !== undefined);
  return hasAnyField ? context : null;
}

/**
 * Builds and validates a `GenerationPlan`. Throws `MissingSourceImagesError`
 * if `sourceMediaIds` doesn't resolve to any of the product's own media, or
 * `ProductNotAnalyzedError` if the product has no READY Product Intelligence
 * profile yet — generation without identity anchors would defeat the point
 * of the "product facts vs. creative direction" split (docs/generation.md
 * "Identity preservation"), so this phase requires analysis first rather
 * than silently generating with `productFacts.identityAnchors: null`.
 */
export function buildGenerationPlan(input: BuildGenerationPlanInput): GenerationPlan {
  const {
    product,
    intelligence,
    sourceMediaIds,
    generationType,
    visualDirectionOverride,
    outputCountOverride,
    brandStylePreset,
    lifestyleSceneOverride,
    aspectRatioOverride,
  } = input;

  const requestedIds = new Set(sourceMediaIds);
  const sourceImages = product.media
    .filter((media) => requestedIds.has(media.id))
    .map((media) => ({
      mediaId: media.id,
      // Full-resolution URL, not the preview — same convention as
      // services/intelligence/build-input.ts (better reference quality
      // for the provider; nothing else in this domain has a reason to
      // prefer the smaller preview).
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
    // Defensive: identityAnchors was already schema-validated when the
    // profile was saved (services/intelligence/schema.ts) — this only
    // trips if the stored JSON was somehow corrupted after the fact.
    throw new ProductNotAnalyzedError();
  }

  // MODEL_SHOOT requires Product Intelligence to have determined this
  // product is model-suitable — generating "model photography" of, say, a
  // sofa would be meaningless (see ProductNotModelSuitableError's doc
  // comment).
  if (generationType === "MODEL_SHOOT" && intelligence.modelSuitable !== true) {
    throw new ProductNotModelSuitableError();
  }

  const category = intelligence.category ?? (product.productType || "product");

  // LIFESTYLE resolves its scene (surface/props/camera/mood/colorDirection
  // + environment/photographyStyle) via the resolved brand style preset
  // (if any) and category-aware defaults — see
  // services/generation/lifestyle-scene.ts. Every other generationType
  // keeps its existing behavior untouched (Product Intelligence's own
  // recommendedEnvironments/recommendedPhotographyStyles, no preset/scene
  // concept at all).
  const sceneResolution =
    generationType === "LIFESTYLE"
      ? buildLifestyleScene({
          categorySignal: category,
          preset: brandStylePreset?.attributes ?? null,
          override: lifestyleSceneOverride,
        })
      : null;

  const environment =
    visualDirectionOverride?.environment ??
    (generationType === "LIFESTYLE" ? sceneResolution!.environment : null) ??
    intelligence.recommendedEnvironments[0] ??
    null;
  const lighting = visualDirectionOverride?.lighting ?? null;
  const composition = visualDirectionOverride?.composition ?? null;
  const photographyStyle =
    (generationType === "LIFESTYLE" ? sceneResolution!.photographyStyle : null) ??
    intelligence.recommendedPhotographyStyles[0] ??
    null;
  const negativeConstraints =
    visualDirectionOverride?.negativeConstraints ?? sceneResolution?.negativeConstraints ?? [];

  // MODEL_SHOOT-only: the pose Product Intelligence recommended for this
  // category, and the resolved preset's own model-styling attribute (if
  // any) — mirrors how LIFESTYLE resolves its scene, just simpler (no
  // category-aware scene table for poses; recommendedPoseTypes IS already
  // the category-aware source, populated since Phase 2).
  const pose = generationType === "MODEL_SHOOT" ? (intelligence.recommendedPoseTypes[0] ?? null) : null;
  const modelStyle = generationType === "MODEL_SHOOT" ? (brandStylePreset?.attributes.modelStyle ?? null) : null;

  // BANNER/CTA-only: a resolved preset's own background/composition/mood
  // attributes, used directly — no category-aware fallback table the way
  // LIFESTYLE has one, since a promotional banner's styling is meant to
  // be brand-driven, not category-inferred.
  const isBannerLike = generationType === "BANNER" || generationType === "CTA";
  const backgroundStyle = isBannerLike ? (brandStylePreset?.attributes.backgroundStyle ?? null) : null;
  const compositionStyle = isBannerLike ? (brandStylePreset?.attributes.compositionStyle ?? null) : null;
  const promotionalMood = isBannerLike ? (brandStylePreset?.attributes.mood ?? null) : null;

  const plan = {
    generationType,
    assetType: intelligence.recommendedAssetTypes[0] ?? null,
    category,

    sourceProductId: product.id,
    sourceImages,

    productFacts: {
      identityAnchors: identityAnchorsResult.data,
    },

    creativeDirection: {
      prompt: synthesizePrompt({
        generationType,
        category,
        material: intelligence.material,
        primaryColor: intelligence.primaryColor,
        style: intelligence.style,
        environment,
        photographyStyle,
        scene: sceneResolution?.scene,
        pose,
        modelStyle,
        backgroundStyle,
        compositionStyle,
        mood: promotionalMood,
      }),
      negativeConstraints,
      environment,
      lighting,
      composition,
    },

    aspectRatio: aspectRatioOverride ?? DEFAULT_ASPECT_RATIO_BY_TYPE[generationType] ?? DEFAULT_ASPECT_RATIO,
    outputFormat: "png",
    quality: "standard",
    outputCount: outputCountOverride ?? 1,

    modelConfiguration:
      intelligence.modelSuitable === null
        ? null
        : {
            modelSuitable: intelligence.modelSuitable,
            recommendedModelAttributes: intelligence.recommendedModelAttributes as Record<string, unknown> | null,
            recommendedPoseTypes: intelligence.recommendedPoseTypes,
          },

    // brandStyle applies to every type in PRESET_APPLICABLE_TYPES — the
    // same BrandStylePreset (its `modelStyle`/`backgroundStyle`/
    // `compositionStyle`/`mood` fields) is shared across all of them, not
    // a separate preset concept per generationType; see
    // docs/lifestyle-generation.md "Brand style presets" for why one
    // preset schema deliberately covers all of them. A preset passed for
    // any other generationType is silently ignored rather than leaking
    // into a plan it wasn't meant for. lifestyleScene stays LIFESTYLE-only.
    brandStyle:
      PRESET_APPLICABLE_TYPES.has(generationType) && brandStylePreset
        ? toBrandStyleContext(brandStylePreset.attributes)
        : null,
    lifestyleScene: sceneResolution?.scene ?? null,

    constraints: [],
  };

  return parseGenerationPlan(plan);
}
