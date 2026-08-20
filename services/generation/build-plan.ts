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
import { parseGenerationPlan, type GenerationPlan } from "./schema";
import type { GenerationTypeValue } from "./types";

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
};

const DEFAULT_ASPECT_RATIO = "1:1";

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

function synthesizePrompt(input: {
  generationType: GenerationTypeValue;
  category: string;
  material: string | null;
  primaryColor: string | null;
  style: string | null;
  environment: string | null;
  photographyStyle: string | null;
}): string {
  const descriptor = [input.primaryColor, input.material, input.category].filter(Boolean).join(" ").trim();
  const subject = descriptor || "product";

  if (input.generationType === "PRODUCT_CLEANUP") {
    return (
      `Clean, evenly lit product photography of the ${subject}. Preserve the product exactly as ` +
      `shown in the source image — do not alter its shape, material, color, or any visible ` +
      `branding. Neutral, distraction-free background.`
    );
  }

  const parts = [`${GENERATION_TYPE_LABEL[input.generationType]} photography of the ${subject}`];
  if (input.style) parts.push(`${input.style} style`);
  if (input.environment) parts.push(`set in ${input.environment}`);
  if (input.photographyStyle) parts.push(`${input.photographyStyle} photography style`);
  return `${parts.join(", ")}.`;
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
  const { product, intelligence, sourceMediaIds, generationType, visualDirectionOverride, outputCountOverride } =
    input;

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

  const environment = visualDirectionOverride?.environment ?? intelligence.recommendedEnvironments[0] ?? null;
  const lighting = visualDirectionOverride?.lighting ?? null;
  const composition = visualDirectionOverride?.composition ?? null;
  const category = intelligence.category ?? (product.productType || "product");

  const plan = {
    generationType,
    assetType: intelligence.recommendedAssetTypes[0] ?? null,

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
        photographyStyle: intelligence.recommendedPhotographyStyles[0] ?? null,
      }),
      negativeConstraints: visualDirectionOverride?.negativeConstraints ?? [],
      environment,
      lighting,
      composition,
    },

    aspectRatio: DEFAULT_ASPECT_RATIO,
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

    brandStyle: null,

    constraints: [],
  };

  return parseGenerationPlan(plan);
}
