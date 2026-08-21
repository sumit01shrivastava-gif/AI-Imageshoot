/**
 * Pure mapping: a persisted `GenerationPlan` → `GenerateImageInput`, the
 * shape `ImageGenerationProvider.generateImage` actually takes (see
 * services/ai/types.ts). Kept separate from build-plan.ts because the
 * plan is the durable, structured *request*; this is the narrower,
 * provider-facing *call* built from it each time a job actually runs
 * (including on retry, where only `attempt` differs).
 */
import type { GenerateImageInput, GenerationMode } from "../ai/types";
import type { GenerationPlan } from "./schema";

export function buildGenerateImageInput(plan: GenerationPlan, attempt: number): GenerateImageInput {
  return {
    generationType: plan.generationType,
    sourceImages: plan.sourceImages,
    productFacts: plan.productFacts,
    creativeDirection: plan.creativeDirection,
    aspectRatio: plan.aspectRatio,
    outputFormat: plan.outputFormat,
    quality: plan.quality,
    outputCount: plan.outputCount,
    attempt,
    brandStyle: plan.brandStyle,
    // Flatten the plan's lifestyleScene OR creativeIntent.creative (if
    // either is present — mutually exclusive by construction, see
    // schema.ts) into the provider's generic sceneDetails — this IS the
    // "provider adapter" boundary (docs/lifestyle-generation.md "Provider
    // strategy" / docs/creative-studio.md "Provider abstraction"):
    // services/ai/ never needs to know either domain's field names.
    sceneDetails: plan.lifestyleScene ?? plan.creativeIntent?.creative ?? undefined,
    // See services/ai/types.ts's GenerationMode/GenerationReferenceImage
    // doc comments — both absent for every pre-existing generationType
    // (unchanged behavior), always present for CREATIVE_STUDIO.
    mode: plan.creativeIntent ? (plan.creativeIntent.mode as GenerationMode) : undefined,
    referenceImages: plan.referenceImages.length > 0 ? plan.referenceImages : undefined,
  };
}
