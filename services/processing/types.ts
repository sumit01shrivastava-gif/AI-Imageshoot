/**
 * Processing operation taxonomy and its supporting shared types.
 *
 * `IMAGE_OPERATIONS` mirrors `prisma/schema.prisma`'s `ImageOperation`
 * enum values (kept as a plain string-literal union — see
 * services/generation/types.ts for why: pure, no-I/O modules in this
 * domain don't need a Prisma import). Any change to one must be mirrored
 * in the other — see tests/unit/processing/types.test.ts.
 */

/** See docs/image-processing.md "Provider selection" for which of these
 * `ProductionImageProcessingProvider` actually implements
 * (REMOVE_BACKGROUND/ENHANCE/RESIZE) versus which remain interface-only
 * (UPSCALE/GENERATE_SHADOW/CROP). */
export const IMAGE_OPERATIONS = [
  "REMOVE_BACKGROUND",
  "ENHANCE",
  "UPSCALE",
  "GENERATE_SHADOW",
  "RESIZE",
  "CROP",
] as const;

export type ImageOperationValue = (typeof IMAGE_OPERATIONS)[number];

/** Operations reachable from a real provider this phase — the batch/product
 * detail UI only ever offers these three (see docs/image-processing.md
 * "Basic plan boundary"). UPSCALE/GENERATE_SHADOW/CROP are valid,
 * schema-accepted taxonomy values with no UI entry point yet. */
export const IMPLEMENTED_OPERATIONS = ["REMOVE_BACKGROUND", "ENHANCE", "RESIZE"] as const;

/** Deterministic aspect-ratio presets for RESIZE — see
 * docs/image-processing.md "Aspect ratio / channel outputs". Reusable
 * across ecommerce channels, not hardcoded to one platform. */
export const ASPECT_RATIO_PRESETS = ["1:1", "4:5", "16:9"] as const;
export type AspectRatioPreset = (typeof ASPECT_RATIO_PRESETS)[number];
