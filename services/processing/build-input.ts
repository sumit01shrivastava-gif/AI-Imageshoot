/**
 * Pure mapping: a source image reference + validated processing options →
 * `ImageProcessingInput`, the shape `ImageProcessingProvider`'s methods
 * take (see services/ai/types.ts). Kept as its own module — thin today —
 * for the same reason services/generation/build-input.ts is: a stable,
 * independently-testable seam between "what we persisted" and "what the
 * provider call actually needs".
 */
import type { ImageProcessingInput, ProductImageReference } from "../ai/types";
import type { ProcessingOptions } from "./schema";

export function buildImageProcessingInput(
  sourceImage: ProductImageReference,
  options: ProcessingOptions,
): ImageProcessingInput {
  return { sourceImage, options };
}
