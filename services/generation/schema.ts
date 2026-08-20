/**
 * Structured, validated shapes for the generation domain.
 *
 * Two independent validation gates, mirroring services/intelligence/schema.ts's
 * "reject malformed input/output, never silently accept it" philosophy:
 *
 *   - `GenerationPlanSchema` validates a plan we ourselves constructed
 *     (`build-plan.ts`) before it's persisted — catches a bug in plan
 *     construction early, at the point it's introduced, not later when a
 *     provider chokes on it.
 *   - `GenerateImageResultSchema`-adjacent checks in `job.server.ts`
 *     validate a *provider's* output (untrusted) before anything is
 *     persisted — see that file.
 */
import { z } from "zod";
import { GENERATION_TYPES, OUTPUT_FORMATS, GENERATION_QUALITIES } from "./types";
import { IdentityAnchorsSchema } from "../intelligence/schema";

export const GenerationTypeSchema = z.enum(GENERATION_TYPES);
export const OutputFormatSchema = z.enum(OUTPUT_FORMATS);
export const GenerationQualitySchema = z.enum(GENERATION_QUALITIES);

/** Mirrors `services/ai/types.ts`'s `BrandStyleContext` — see
 * docs/generation.md "Brand style". Every field optional: nothing
 * constructs a real one yet (see docs/product-intelligence.md "Brand
 * style foundation"), this only validates one if present. */
export const BrandStyleContextSchema = z.object({
  visualTone: z.string().min(1).optional(),
  colorPalette: z.array(z.string()).optional(),
  photographyStyle: z.string().min(1).optional(),
  backgroundStyle: z.string().min(1).optional(),
  lightingStyle: z.string().min(1).optional(),
  compositionStyle: z.string().min(1).optional(),
  luxuryLevel: z.string().min(1).optional(),
  modelStyle: z.string().min(1).optional(),
});

export const SourceImageSchema = z.object({
  mediaId: z.string().min(1),
  url: z.string().min(1),
  altText: z.string().nullable(),
  position: z.number().int(),
});

/**
 * The structured bridge between Product Intelligence and image generation
 * — see docs/generation.md "Generation plan". Everything the UI is
 * allowed to influence flows through this, never a raw prompt string (see
 * docs/generation.md "No arbitrary prompts").
 *
 * `productFacts`/`creativeDirection` are the explicit split this phase
 * requires (docs/generation.md "Identity preservation"): `productFacts`
 * must remain stable across regenerations of the same product;
 * `creativeDirection` is exactly what's allowed to change.
 */
export const GenerationPlanSchema = z.object({
  generationType: GenerationTypeSchema,
  assetType: z.string().min(1).nullable(),

  sourceProductId: z.string().min(1),
  sourceImages: z.array(SourceImageSchema).min(1),

  /** Snapshot of the product's identity-critical attributes at plan-build
   * time — see services/intelligence/schema.ts's `IdentityAnchorsSchema`.
   * Reused directly (not redefined) so the two stay in lockstep by
   * construction. Mandatory whenever Product Intelligence has run for
   * this product; null only when it hasn't (see build-plan.ts). */
  productFacts: z
    .object({
      identityAnchors: IdentityAnchorsSchema.nullable(),
    })
    .strict(),

  creativeDirection: z.object({
    /** System-synthesized, never merchant-typed free text — see
     * docs/generation.md "No arbitrary prompts". */
    prompt: z.string().min(1),
    negativeConstraints: z.array(z.string()).default([]),
    environment: z.string().min(1).nullable().default(null),
    lighting: z.string().min(1).nullable().default(null),
    composition: z.string().min(1).nullable().default(null),
  }),

  aspectRatio: z.string().min(1),
  outputFormat: OutputFormatSchema,
  quality: GenerationQualitySchema,
  outputCount: z.number().int().min(1).max(4),

  modelConfiguration: z
    .object({
      modelSuitable: z.boolean(),
      recommendedModelAttributes: z.record(z.string(), z.unknown()).nullable(),
      recommendedPoseTypes: z.array(z.string()),
    })
    .nullable(),

  brandStyle: BrandStyleContextSchema.nullable(),

  constraints: z.array(z.string()).default([]),
});

export type GenerationPlan = z.infer<typeof GenerationPlanSchema>;

export class InvalidGenerationPlanError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid generation plan: ${issues.join("; ")}`);
    this.name = "InvalidGenerationPlanError";
    this.issues = issues;
  }
}

/** Validates a plan we constructed ourselves — throws on anything
 * malformed rather than persisting a plan the provider/job pipeline can't
 * trust. See module doc comment. */
export function parseGenerationPlan(raw: unknown): GenerationPlan {
  const result = GenerationPlanSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new InvalidGenerationPlanError(issues);
  }
  return result.data;
}

/**
 * Light validation of a provider's raw `GenerateImageResult` — deliberately
 * NOT a full Zod schema (image bytes aren't a meaningful thing to
 * schema-validate structurally the way JSON is), just the checks that
 * catch a provider returning something we categorically cannot use. See
 * CLAUDE.md "Reject malformed provider output" applied to this domain.
 */
export class InvalidGenerationResultError extends Error {
  constructor(reason: string) {
    super(`Provider returned an invalid generation result: ${reason}`);
    this.name = "InvalidGenerationResultError";
  }
}

export function assertValidGenerateImageResult(result: {
  outputs: Array<{ data: Uint8Array; contentType: string }>;
}): void {
  if (!Array.isArray(result.outputs) || result.outputs.length === 0) {
    throw new InvalidGenerationResultError("no outputs were returned");
  }
  for (const [index, output] of result.outputs.entries()) {
    if (!(output.data instanceof Uint8Array) || output.data.byteLength === 0) {
      throw new InvalidGenerationResultError(`output[${index}] has no image data`);
    }
    if (!output.contentType || typeof output.contentType !== "string") {
      throw new InvalidGenerationResultError(`output[${index}] is missing a contentType`);
    }
  }
}
