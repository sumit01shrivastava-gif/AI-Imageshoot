/**
 * Structured, validated shapes for the store-visuals domain — a sibling of
 * services/generation/schema.ts, reusing its shared building blocks
 * (`SourceImageSchema`, `BrandStyleContextSchema`, `AspectRatioSchema`,
 * `OutputFormatSchema`, `GenerationQualitySchema`) rather than duplicating
 * them, but with its own top-level plan shape: a store visual references
 * ZERO..N products (`products: []` by default), not exactly one — see
 * docs/store-visuals.md "Why a separate model family".
 */
import { z } from "zod";
import { STORE_VISUAL_TYPES } from "./types";
import {
  SourceImageSchema,
  BrandStyleContextSchema,
  AspectRatioSchema,
  OutputFormatSchema,
  GenerationQualitySchema,
} from "../generation/schema";
import { IdentityAnchorsSchema } from "../intelligence/schema";

export const StoreVisualTypeSchema = z.enum(STORE_VISUAL_TYPES);
export { AspectRatioSchema };

/**
 * One product featured in a store visual — identity anchors are captured
 * best-effort (`nullable`, not required the way `GenerationPlanSchema`
 * requires them): a store visual is never BLOCKED on a referenced
 * product's Product Intelligence being ready, unlike single-product
 * generation, since the visual isn't primarily about preserving one
 * product's exact appearance the same way LIFESTYLE/MODEL_SHOOT/BANNER
 * are — see build-plan.ts.
 */
export const StoreVisualProductRefSchema = z.object({
  productId: z.string().min(1),
  productTitle: z.string().min(1),
  identityAnchors: IdentityAnchorsSchema.nullable(),
  sourceImages: z.array(SourceImageSchema).default([]),
});

export type StoreVisualProductRef = z.infer<typeof StoreVisualProductRefSchema>;

/**
 * The structured bridge between an optional product selection + brand
 * style + visual type and image generation — mirrors
 * `GenerationPlanSchema`'s "everything the UI is allowed to influence
 * flows through this, never a raw prompt string" rule (see
 * docs/generation.md "No arbitrary prompts") exactly.
 */
export const StoreVisualPlanSchema = z.object({
  visualType: StoreVisualTypeSchema,

  /** Zero, one, or several featured products — the defining structural
   * difference from `GenerationPlanSchema.sourceProductId`/`sourceImages`,
   * which require exactly one. */
  products: z.array(StoreVisualProductRefSchema).default([]),

  creativeDirection: z.object({
    /** System-synthesized, never merchant-typed free text — see
     * docs/generation.md "No arbitrary prompts". */
    prompt: z.string().min(1),
    negativeConstraints: z.array(z.string()).default([]),
    environment: z.string().min(1).nullable().default(null),
    lighting: z.string().min(1).nullable().default(null),
    composition: z.string().min(1).nullable().default(null),
  }),

  aspectRatio: AspectRatioSchema,
  outputFormat: OutputFormatSchema,
  quality: GenerationQualitySchema,
  outputCount: z.number().int().min(1).max(4),

  /** Same field/reasoning as services/generation/schema.ts's
   * `GenerationPlanSchema.maxResolutionPx` — set unconditionally by
   * `requestStoreVisual` from the shop's real resolved plan, never
   * merchant-supplied. */
  maxResolutionPx: z.number().int().positive().nullable().default(null),

  brandStyle: BrandStyleContextSchema.nullable(),

  constraints: z.array(z.string()).default([]),
});

export type StoreVisualPlan = z.infer<typeof StoreVisualPlanSchema>;

export class InvalidStoreVisualPlanError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid store visual plan: ${issues.join("; ")}`);
    this.name = "InvalidStoreVisualPlanError";
    this.issues = issues;
  }
}

/** Validates a plan we constructed ourselves — throws on anything
 * malformed rather than persisting a plan the provider/job pipeline can't
 * trust. See module doc comment and services/generation/schema.ts's
 * `parseGenerationPlan`, which this mirrors. */
export function parseStoreVisualPlan(raw: unknown): StoreVisualPlan {
  const result = StoreVisualPlanSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new InvalidStoreVisualPlanError(issues);
  }
  return result.data;
}

// A provider's raw output is validated the exact same way regardless of
// which domain requested it — reused directly rather than duplicated.
export { assertValidGenerateImageResult, InvalidGenerationResultError } from "../generation/schema";
