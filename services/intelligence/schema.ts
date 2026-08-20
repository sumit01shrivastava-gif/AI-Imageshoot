/**
 * Structured, validated shape of one Product Intelligence analysis result.
 *
 * An `AIProvider.analyzeProduct` call returns loosely-typed, untrusted JSON
 * (`ProductAnalysisRawOutput` — see services/ai/types.ts). This schema is
 * the single gate everything must pass through before it's persisted or
 * shown to a merchant — see CLAUDE.md "Reject malformed provider output"
 * and docs/product-intelligence.md "Schema". Malformed output is rejected,
 * never silently accepted or coerced into something plausible-looking.
 */
import { z } from "zod";
import { ASSET_TYPES } from "./category-recommendations";

export const AssetTypeSchema = z.enum(ASSET_TYPES);

export const GenderSuitabilitySchema = z.enum(["men", "women", "unisex", "kids", "not_applicable"]);

export const PricePositioningSchema = z.enum(["budget", "mid_range", "premium", "luxury"]);

export const ImageRelevanceSchema = z.enum(["primary", "secondary", "detail", "packaging", "irrelevant"]);

/**
 * Identity-critical attributes a future generation stage must preserve —
 * never invent or alter beyond what the source product/images genuinely
 * support. See docs/product-intelligence.md "Identity preservation".
 * Mandatory (not optional) on every READY profile: a profile with no
 * identity anchors would give a future generation stage nothing to
 * constrain against, which defeats the point of this section existing.
 */
export const IdentityAnchorsSchema = z.object({
  category: z.string().min(1),
  shape: z.string().min(1).nullable().default(null),
  material: z.string().min(1).nullable().default(null),
  primaryColor: z.string().min(1).nullable().default(null),
  constructionDetails: z.array(z.string()).default([]),
  distinctiveHardware: z.array(z.string()).default([]),
  brandingVisible: z.boolean().default(false),
  brandingDescription: z.string().min(1).nullable().default(null),
});

export type IdentityAnchors = z.infer<typeof IdentityAnchorsSchema>;

const QualityIndicatorLevel = z.enum(["low", "medium", "high"]);

export const ImageAnalysisSchema = z.object({
  /** Our `ShopifyProductMedia.id` this observation is about. */
  mediaId: z.string().min(1),
  url: z.string().min(1),
  relevance: ImageRelevanceSchema.default("secondary"),
  qualityIndicators: z
    .object({
      sharpness: QualityIndicatorLevel.nullable().default(null),
      lighting: QualityIndicatorLevel.nullable().default(null),
      backgroundClarity: z.enum(["cluttered", "plain", "studio"]).nullable().default(null),
    })
    .nullable()
    .default(null),
  identityObservations: z.array(z.string()).default([]),
});

export type ImageAnalysis = z.infer<typeof ImageAnalysisSchema>;

/**
 * The full structured Product Intelligence profile. Every provider's raw
 * output is parsed through this — see `parseProductIntelligenceOutput`
 * below.
 *
 * Deliberately not `.strict()`: a provider returning one extra,
 * unrecognized field (e.g. its own internal trace id) shouldn't fail
 * validation for fields we don't care about — we only strictly validate
 * the fields we actually persist/use.
 */
export const ProductIntelligenceSchema = z.object({
  category: z.string().min(1),
  subcategory: z.string().min(1).nullable().default(null),
  productType: z.string().min(1).nullable().default(null),

  material: z.string().min(1).nullable().default(null),
  primaryColor: z.string().min(1).nullable().default(null),
  secondaryColors: z.array(z.string()).default([]),

  pattern: z.string().min(1).nullable().default(null),
  texture: z.string().min(1).nullable().default(null),
  style: z.string().min(1).nullable().default(null),

  useCases: z.array(z.string()).default([]),
  targetAudience: z.string().min(1).nullable().default(null),
  genderSuitability: GenderSuitabilitySchema.nullable().default(null),
  seasonality: z.array(z.string()).default([]),
  pricePositioning: PricePositioningSchema.nullable().default(null),

  visualCharacteristics: z.record(z.string(), z.unknown()).nullable().default(null),
  productDimensions: z.record(z.string(), z.unknown()).nullable().default(null),
  packagingCharacteristics: z.record(z.string(), z.unknown()).nullable().default(null),
  hardwareComponents: z.array(z.string()).default([]),

  modelSuitable: z.boolean(),
  recommendedModelAttributes: z.record(z.string(), z.unknown()).nullable().default(null),
  recommendedPoseTypes: z.array(z.string()).default([]),

  recommendedEnvironments: z.array(z.string()).default([]),
  recommendedProps: z.array(z.string()).default([]),
  recommendedPhotographyStyles: z.array(z.string()).default([]),
  recommendedAssetTypes: z.array(AssetTypeSchema).min(1),

  identityAnchors: IdentityAnchorsSchema,
  imageAnalyses: z.array(ImageAnalysisSchema).default([]),

  /** The provider's own self-reported confidence, when it exposes one. */
  confidence: z.number().min(0).max(1).nullable().default(null),
});

export type ProductIntelligenceData = z.infer<typeof ProductIntelligenceSchema>;

export class InvalidProductIntelligenceOutputError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Provider returned invalid Product Intelligence output: ${issues.join("; ")}`);
    this.name = "InvalidProductIntelligenceOutputError";
    this.issues = issues;
  }
}

/**
 * Validates raw provider output against `ProductIntelligenceSchema`.
 * Throws `InvalidProductIntelligenceOutputError` — never coerces or
 * silently drops invalid data — on anything that doesn't conform. See
 * CLAUDE.md "Reject malformed provider output".
 */
export function parseProductIntelligenceOutput(raw: unknown): ProductIntelligenceData {
  const result = ProductIntelligenceSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new InvalidProductIntelligenceOutputError(issues);
  }
  return result.data;
}
