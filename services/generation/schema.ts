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
import { GENERATION_TYPES, OUTPUT_FORMATS, GENERATION_QUALITIES, ASPECT_RATIOS } from "./types";
import { IdentityAnchorsSchema } from "../intelligence/schema";

export const GenerationTypeSchema = z.enum(GENERATION_TYPES);
export const OutputFormatSchema = z.enum(OUTPUT_FORMATS);
export const GenerationQualitySchema = z.enum(GENERATION_QUALITIES);
export const AspectRatioSchema = z.enum(ASPECT_RATIOS);

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
 * The lifestyle-specific portion of a generation plan — see
 * docs/lifestyle-generation.md "LifestyleScenePlan". Nested under
 * `GenerationPlanSchema.lifestyleScene` rather than folded into
 * `creativeDirection` (below) so PRODUCT_CLEANUP's existing, tested plan
 * shape/behavior is untouched: `environment`/`lighting`/`composition`/
 * `negativeConstraints` stay in `creativeDirection` (meaningful for every
 * generation type), while these fields only ever apply to LIFESTYLE.
 * `null` for every non-LIFESTYLE `generationType`.
 */
export const LifestyleSceneSchema = z.object({
  /** e.g. "in-use", "styled flat lay", "environmental". */
  sceneType: z.string().min(1).nullable(),
  surface: z.string().min(1).nullable(),
  props: z.array(z.string()).default([]),
  /** e.g. "eye-level", "45-degree overhead". */
  camera: z.string().min(1).nullable(),
  mood: z.string().min(1).nullable(),
  colorDirection: z.string().min(1).nullable(),
});

export type LifestyleScene = z.infer<typeof LifestyleSceneSchema>;

/**
 * The Creative Studio-specific portion of a generation plan — populated
 * only when `generationType === "CREATIVE_STUDIO"`, mirroring
 * `lifestyleScene`'s exact placement pattern (a separate, optional nested
 * field, not folded into `creativeDirection`, so every other
 * generationType's tested shape/behavior stays untouched).
 *
 * `creative` (what MAY change) and `identityConstraints` (what must NOT
 * change) are deliberately two separate sub-objects — see
 * services/creative-studio/identity-constraints.ts's doc comment and
 * docs/creative-studio.md "Identity preservation": Part 4's requirement
 * that this distinction "exist structurally in the generation plan rather
 * than only as prose."
 *
 * `intent`/`mode` are recorded as plain strings, not re-imported enums —
 * services/creative-studio/intent-schema.ts's `CreativeIntentSchema`/
 * `GenerationModeSchema` are the actual validation gate for these values
 * (already validated by the time a plan is built); this file stays free
 * of any dependency on services/creative-studio/, since generation is the
 * lower-level, reusable building block and creative-studio is the
 * higher-level orchestrator built on top of it — never the reverse (see
 * CLAUDE.md's domain boundaries).
 */
export const CreativeStudioPlanSchema = z.object({
  intent: z.string().min(1),
  mode: z.string().min(1),

  creative: z.object({
    /** The standalone (no Shopify product) session's resolved subject —
     * e.g. "a pair of sneakers" — read back on a later turn as
     * `CreativeContext.activeSubject` (services/creative-studio/
     * creative-context.ts) so a follow-up that doesn't restate the
     * subject still knows what's being depicted. `null` for the
     * Shopify-product path (which has a real category instead — see
     * services/creative-studio/plan-builder.ts's
     * `buildCreativeGenerationPlan`) and for a standalone turn where no
     * subject was ever established. `.nullable().default(null)` so an
     * older persisted `GenerationJob.plan` without this field (from
     * before it existed) still parses fine — no migration needed. */
    subject: z.string().min(1).nullable().default(null),
    scene: z.string().min(1).nullable().default(null),
    style: z.array(z.string()).default([]),
    lighting: z.string().min(1).nullable().default(null),
    composition: z.string().min(1).nullable().default(null),
    camera: z.string().min(1).nullable().default(null),
    colorDirection: z.string().min(1).nullable().default(null),
    addElements: z.array(z.string()).default([]),
    removeElements: z.array(z.string()).default([]),
    /** Requested removals that named a protected brand/identity element
     * (e.g. "remove the logo") and were structurally excluded from
     * `removeElements`/the synthesized prompt rather than silently
     * honored — see services/creative-studio/identity-constraints.ts's
     * `filterProtectedRemovals`. Empty when nothing was blocked. Kept for
     * traceability/history display and so the merchant's chat
     * acknowledgement can note the decline instead of the request just
     * silently not happening. */
    blockedRemovals: z.array(z.string()).default([]),
  }),

  identityConstraints: z.object({
    immutable: z.array(z.string()).default([]),
    instruction: z.string().min(1),
  }),

  /** Kept for traceability/debugging/history display only — NEVER reused
   * as prompt text (the prompt was already synthesized into
   * `creativeDirection.prompt` by the time this plan exists). See
   * docs/creative-studio.md "No arbitrary prompts". */
  creativeSessionId: z.string().min(1),
  rawInstruction: z.string().min(1),
});

export type CreativeStudioPlan = z.infer<typeof CreativeStudioPlanSchema>;

/** One additional reference image beyond `sourceImages` — see
 * services/ai/types.ts's `GenerationReferenceImage`, which this mirrors
 * structurally at the persisted-plan layer. */
export const ReferenceImageSchema = z.object({
  url: z.string().min(1),
  role: z.enum(["product_original", "previous_result", "style_reference"]),
});

/**
 * A merchant-saved OR built-in brand style preset's structured
 * attributes — see docs/lifestyle-generation.md "Brand style presets".
 * Deliberately a superset of `BrandStyleContextSchema` (the narrower
 * shape actually sent to the provider) plus scene defaults: the
 * instructions' own preset examples (Minimal Studio, Luxury Editorial,
 * ...) mix brand-style attributes (mood, photography style, color
 * direction) and scene attributes (environment, props) into one reusable
 * named thing, so this is one schema, not two. Every field optional —
 * `services/generation/lifestyle-scene.ts` fills gaps with category-aware
 * defaults, never requires a preset to specify everything.
 */
export const BrandStylePresetAttributesSchema = z.object({
  visualTone: z.string().min(1).optional(),
  colorPalette: z.array(z.string()).optional(),
  photographyStyle: z.string().min(1).optional(),
  backgroundStyle: z.string().min(1).optional(),
  lightingStyle: z.string().min(1).optional(),
  compositionStyle: z.string().min(1).optional(),
  luxuryLevel: z.string().min(1).optional(),
  modelStyle: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  surface: z.string().min(1).optional(),
  props: z.array(z.string()).optional(),
  camera: z.string().min(1).optional(),
  mood: z.string().min(1).optional(),
  colorDirection: z.string().min(1).optional(),
  negativeConstraints: z.array(z.string()).optional(),
});

export type BrandStylePresetAttributes = z.infer<typeof BrandStylePresetAttributesSchema>;

export class InvalidBrandStylePresetError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid brand style preset attributes: ${issues.join("; ")}`);
    this.name = "InvalidBrandStylePresetError";
    this.issues = issues;
  }
}

/** Validates a preset's attributes — a merchant's own input for a custom
 * preset, or this module's built-in catalog — throwing on anything
 * malformed rather than persisting/using an untrustworthy shape. See
 * CLAUDE.md "Reject malformed provider output", applied here to merchant
 * input. */
export function parseBrandStylePresetAttributes(raw: unknown): BrandStylePresetAttributes {
  const result = BrandStylePresetAttributesSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new InvalidBrandStylePresetError(issues);
  }
  return result.data;
}

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
  /** The product's category — informational, alongside `assetType`;
   * mirrors `services/intelligence`'s `category` field rather than
   * re-deriving it. Populated for every generation type, not just
   * LIFESTYLE (useful context regardless). */
  category: z.string().min(1).nullable(),

  /** Null for a standalone (no Shopify product) Creative Studio plan —
   * see prisma/schema.prisma's GenerationJob.productId comment. Present
   * (non-null) for every Shopify-context plan, enforced below by
   * `.superRefine` rather than a plain `.min(1)` here, since this field
   * alone can't tell a genuinely product-less plan from a malformed one. */
  sourceProductId: z.string().min(1).nullable(),
  /** At least one image whenever `sourceProductId` is non-null (a
   * Shopify-context plan always has real product media to ground
   * against — enforced below, not weakened by this field's own bound).
   * May be empty for a standalone plan: there is no ShopifyProductMedia
   * to reference at all; an uploaded reference image (if any) lives in
   * `referenceImages` instead — see
   * services/creative-studio/plan-builder.ts's
   * `buildStandaloneCreativeGenerationPlan`. */
  sourceImages: z.array(SourceImageSchema).default([]),

  /** Snapshot of the product's identity-critical attributes at plan-build
   * time — see services/intelligence/schema.ts's `IdentityAnchorsSchema`.
   * Reused directly (not redefined) so the two stay in lockstep by
   * construction. Mandatory whenever Product Intelligence has run for
   * this product; null only when it hasn't (see build-plan.ts).
   *
   * `title`/`description`/`attributes` are the product's own Shopify
   * catalog facts (grounding context, not creative direction) — added so
   * a provider genuinely has "what this product actually is" available,
   * not just its identity-preservation anchors. `description` is
   * truncated to a short excerpt (see build-plan.ts's `PRODUCT_FACTS_DESCRIPTION_MAX_CHARS`)
   * — enough to ground the model, not enough to overwhelm a concise,
   * structured provider request with paragraphs of marketing copy (see
   * docs/ai-pipeline.md "Provider-input composition"). */
  productFacts: z
    .object({
      identityAnchors: IdentityAnchorsSchema.nullable(),
      title: z.string().min(1).nullable().default(null),
      description: z.string().min(1).nullable().default(null),
      attributes: z
        .object({
          productType: z.string().min(1).nullable().default(null),
          vendor: z.string().min(1).nullable().default(null),
          tags: z.array(z.string()).default([]),
        })
        .nullable()
        .default(null),
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

  aspectRatio: AspectRatioSchema,
  outputFormat: OutputFormatSchema,
  quality: GenerationQualitySchema,
  outputCount: z.number().int().min(1).max(4),

  /** The shop's real, resolved plan ceiling
   * (`PlanDefinition.maxGenerationResolutionPx` —
   * services/billing/plans.ts) at the moment this job was created — set
   * unconditionally by `createAndEnqueueGenerationJob`
   * (request-generation.server.ts), never merchant-supplied, and never
   * left to whatever a stale/cached plan value might imply later. `null`
   * only for a plan built outside that path (e.g. a unit test
   * constructing a `GenerationPlan` directly) — the provider layer falls
   * back to its own default ceiling in that case. See
   * services/ai/prompt-composition.ts's sibling concern
   * (`sizeForAspectRatio`) and docs/billing.md "Plan limit enforcement". */
  maxResolutionPx: z.number().int().positive().nullable().default(null),

  modelConfiguration: z
    .object({
      modelSuitable: z.boolean(),
      recommendedModelAttributes: z.record(z.string(), z.unknown()).nullable(),
      recommendedPoseTypes: z.array(z.string()),
    })
    .nullable(),

  brandStyle: BrandStyleContextSchema.nullable(),

  /** Populated only when `generationType === "LIFESTYLE"` — see
   * `LifestyleSceneSchema`'s doc comment for why this is a separate,
   * optional field rather than folded into `creativeDirection`. */
  lifestyleScene: LifestyleSceneSchema.nullable(),

  /** Populated only when `generationType === "CREATIVE_STUDIO"` — see
   * `CreativeStudioPlanSchema`'s doc comment. `null` for every other
   * generationType. */
  creativeIntent: CreativeStudioPlanSchema.nullable().default(null),

  /** Additional reference images beyond `sourceImages` (e.g. the exact
   * prior result a conversational follow-up edits forward from) — see
   * `ReferenceImageSchema`'s doc comment. Empty for every generationType
   * that isn't CREATIVE_STUDIO. */
  referenceImages: z.array(ReferenceImageSchema).default([]),

  constraints: z.array(z.string()).default([]),
}).superRefine((plan, ctx) => {
  // A Shopify-context plan (`sourceProductId` present) must still have at
  // least one real product source image — the exact same requirement
  // `sourceImages: z.array(...).min(1)` enforced unconditionally before
  // this field became nullable for standalone plans. Never weakened for
  // the Shopify path: only a genuinely product-less (standalone) plan is
  // allowed an empty `sourceImages`. See services/generation/build-plan.ts
  // (which already throws `MissingSourceImagesError` before a plan ever
  // reaches this validation) and
  // services/creative-studio/plan-builder.ts's `buildCreativeGenerationPlan`
  // (same).
  if (plan.sourceProductId && plan.sourceImages.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceImages"],
      message: "sourceImages must have at least one image for a product-grounded (sourceProductId non-null) plan",
    });
  }
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
