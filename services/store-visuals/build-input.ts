/**
 * Pure mapping: a persisted `StoreVisualPlan` → `GenerateImageInput`, the
 * shape `ImageGenerationProvider.generateImage` takes — mirrors
 * services/generation/build-input.ts exactly, reusing `services/ai/types.ts`'s
 * already domain-agnostic `GenerateImageInput` unchanged (no new field
 * needed: `productFacts`/`sceneDetails` are already generic
 * `Record<string, unknown>`).
 */
import type { GenerateImageInput } from "../ai/types";
import type { StoreVisualPlan } from "./schema";

/**
 * `productFacts` here is the array of referenced products' identity
 * anchors (keyed by productId) — a store visual can feature several
 * products, unlike `services/generation/`'s single-product
 * `productFacts.identityAnchors`. An empty array for a fully generic
 * visual (no products referenced) is valid and expected.
 */
export function buildGenerateImageInput(plan: StoreVisualPlan, attempt: number): GenerateImageInput {
  return {
    generationType: plan.visualType,
    sourceImages: plan.products.flatMap((ref) => ref.sourceImages),
    productFacts: {
      products: plan.products.map((ref) => ({ productId: ref.productId, identityAnchors: ref.identityAnchors })),
    },
    creativeDirection: plan.creativeDirection,
    aspectRatio: plan.aspectRatio,
    outputFormat: plan.outputFormat,
    quality: plan.quality,
    outputCount: plan.outputCount,
    maxResolutionPx: plan.maxResolutionPx,
    attempt,
    brandStyle: plan.brandStyle,
  };
}
