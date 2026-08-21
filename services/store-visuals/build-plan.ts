/**
 * Pure mapping: an optional set of products (+ their Product Intelligence,
 * where available) + a visual type + a resolved brand style preset → a
 * validated `StoreVisualPlan`. No I/O — mirrors
 * services/generation/build-plan.ts's shape exactly, adapted for zero..N
 * products instead of exactly one.
 *
 * This is the ONLY place a store-visual prompt is synthesized — always
 * from structured fields, never merchant-typed free text (see
 * docs/generation.md "No arbitrary prompts").
 */
import type { ProductDetail } from "../../db/repositories/shopify-product.repository";
import type { ProductIntelligenceRow } from "../../db/repositories/product-intelligence.repository";
import { IdentityAnchorsSchema } from "../intelligence/schema";
import type { BrandStylePresetAttributes } from "../generation/schema";
import {
  parseStoreVisualPlan,
  type StoreVisualPlan,
  type StoreVisualProductRef,
} from "./schema";
import type { StoreVisualTypeValue, AspectRatioValue } from "./types";

const VISUAL_TYPE_LABEL: Record<StoreVisualTypeValue, string> = {
  HOMEPAGE_HERO: "Homepage hero",
  COLLECTION_BANNER: "Collection banner",
  STORE_CTA: "Store call-to-action",
};

const DEFAULT_ASPECT_RATIO: AspectRatioValue = "1:1";

/** HOMEPAGE_HERO/COLLECTION_BANNER read best wide — mirrors
 * services/generation/build-plan.ts's `DEFAULT_ASPECT_RATIO_BY_TYPE` for
 * BANNER. STORE_CTA keeps the general `1:1` default (often used in social/
 * app-embedded placements, not just a wide hero slot). */
const DEFAULT_ASPECT_RATIO_BY_TYPE: Partial<Record<StoreVisualTypeValue, AspectRatioValue>> = {
  HOMEPAGE_HERO: "21:9",
  COLLECTION_BANNER: "21:9",
};

const NO_TEXT_INSTRUCTION = "Do not render any text, logos, or typography.";
const PRESERVE_PRODUCTS_INSTRUCTION =
  "Preserve each featured product exactly as shown in its source images — do not alter shape, material, color, or any visible branding.";

export interface StoreVisualProductInput {
  product: ProductDetail;
  intelligence: ProductIntelligenceRow | null;
}

export interface BuildStoreVisualPlanInput {
  visualType: StoreVisualTypeValue;
  /** Zero, one, or several featured products — the defining difference
   * from services/generation/build-plan.ts's single, required product.
   * Order is preserved into the plan. */
  products: StoreVisualProductInput[];
  /** Resolved brand style preset (built-in or shop-owned custom) — see
   * services/generation/build-plan.ts's identical parameter. `null`/
   * omitted still produces a fully-formed plan; a store visual has no
   * category-aware fallback table the way LIFESTYLE does (there's no
   * single product category to infer from when zero or several products
   * are referenced), so with no preset the prompt is generic but valid. */
  brandStylePreset?: { id: string; name: string; attributes: BrandStylePresetAttributes } | null;
  aspectRatioOverride?: AspectRatioValue;
  /** Not wired to any route — see services/generation/build-plan.ts's
   * identical parameter's doc comment (test-only escape hatch). */
  outputCountOverride?: number;
  visualDirectionOverride?: {
    environment?: string | null;
    lighting?: string | null;
    composition?: string | null;
    negativeConstraints?: string[];
  };
}

function synthesizePrompt(input: {
  visualType: StoreVisualTypeValue;
  productTitles: string[];
  environment: string | null;
  photographyStyle: string | null;
  compositionStyle: string | null;
  mood: string | null;
}): string {
  const featuring = input.productTitles.length > 0 ? `featuring ${input.productTitles.join(", ")}` : null;

  const parts: string[] = [];
  if (input.visualType === "HOMEPAGE_HERO") {
    parts.push("Wide, cinematic homepage hero photography for an online store");
  } else if (input.visualType === "COLLECTION_BANNER") {
    parts.push("Collection banner photography for an online store");
  } else {
    parts.push("Bold, attention-grabbing store call-to-action imagery");
  }
  if (featuring) parts.push(featuring);
  if (input.environment) parts.push(`set in ${input.environment}`);
  if (input.compositionStyle) parts.push(`${input.compositionStyle} composition`);
  parts.push("composed with clear open space for text overlay");
  if (input.photographyStyle) parts.push(`${input.photographyStyle} photography style`);
  if (input.mood) parts.push(`${input.mood} mood`);

  const trailer = [NO_TEXT_INSTRUCTION, input.productTitles.length > 0 ? PRESERVE_PRODUCTS_INSTRUCTION : null]
    .filter(Boolean)
    .join(" ");
  return `${parts.join(", ")}. ${trailer}`;
}

/**
 * Builds and validates a `StoreVisualPlan`. Never throws on a referenced
 * product's missing/not-`READY` Product Intelligence — identity anchors
 * are captured best-effort (`null` when unavailable), mirroring
 * `services/processing/`'s "never blocked on analysis" reasoning rather
 * than `services/generation/build-plan.ts`'s `ProductNotAnalyzedError`
 * gate: a store visual isn't primarily about preserving one product's
 * exact appearance the way single-product generation is.
 */
export function buildStoreVisualPlan(input: BuildStoreVisualPlanInput): StoreVisualPlan {
  const { visualType, products, brandStylePreset, aspectRatioOverride, outputCountOverride, visualDirectionOverride } =
    input;

  const productRefs: StoreVisualProductRef[] = products.map(({ product, intelligence }) => {
    const identityAnchorsResult =
      intelligence?.status === "READY" ? IdentityAnchorsSchema.safeParse(intelligence.identityAnchors) : null;

    return {
      productId: product.id,
      productTitle: product.title,
      identityAnchors: identityAnchorsResult?.success ? identityAnchorsResult.data : null,
      sourceImages: product.media.map((media) => ({
        mediaId: media.id,
        url: media.originalUrl,
        altText: media.altText,
        position: media.position,
      })),
    };
  });

  const environment = visualDirectionOverride?.environment ?? brandStylePreset?.attributes.environment ?? null;
  const lighting = visualDirectionOverride?.lighting ?? brandStylePreset?.attributes.lightingStyle ?? null;
  const composition = visualDirectionOverride?.composition ?? null;
  const photographyStyle = brandStylePreset?.attributes.photographyStyle ?? null;
  const compositionStyle = brandStylePreset?.attributes.compositionStyle ?? null;
  const mood = brandStylePreset?.attributes.mood ?? null;
  const negativeConstraints = visualDirectionOverride?.negativeConstraints ?? brandStylePreset?.attributes.negativeConstraints ?? [];

  const brandStyle = brandStylePreset
    ? (() => {
        const {
          visualTone,
          colorPalette,
          photographyStyle: presetPhotographyStyle,
          backgroundStyle,
          lightingStyle,
          compositionStyle: presetCompositionStyle,
          luxuryLevel,
          modelStyle,
        } = brandStylePreset.attributes;
        const context = {
          visualTone,
          colorPalette,
          photographyStyle: presetPhotographyStyle,
          backgroundStyle,
          lightingStyle,
          compositionStyle: presetCompositionStyle,
          luxuryLevel,
          modelStyle,
        };
        const hasAnyField = Object.values(context).some((value) => value !== undefined);
        return hasAnyField ? context : null;
      })()
    : null;

  const plan = {
    visualType,
    products: productRefs,

    creativeDirection: {
      prompt: synthesizePrompt({
        visualType,
        productTitles: productRefs.map((ref) => ref.productTitle),
        environment,
        photographyStyle,
        compositionStyle,
        mood,
      }),
      negativeConstraints,
      environment,
      lighting,
      composition,
    },

    aspectRatio: aspectRatioOverride ?? DEFAULT_ASPECT_RATIO_BY_TYPE[visualType] ?? DEFAULT_ASPECT_RATIO,
    outputFormat: "png",
    quality: "standard",
    outputCount: outputCountOverride ?? 1,

    brandStyle,

    constraints: [],
  };

  return parseStoreVisualPlan(plan);
}

export { VISUAL_TYPE_LABEL };
