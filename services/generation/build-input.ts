/**
 * Pure mapping: a persisted `GenerationPlan` → `GenerateImageInput`, the
 * shape `ImageGenerationProvider.generateImage` actually takes (see
 * services/ai/types.ts). Kept separate from build-plan.ts because the
 * plan is the durable, structured *request*; this is the narrower,
 * provider-facing *call* built from it each time a job actually runs
 * (including on retry, where only `attempt` differs).
 */
import type { GenerateImageInput } from "../ai/types";
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
  };
}
