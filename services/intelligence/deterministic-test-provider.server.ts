/**
 * Deterministic, network-free `AIProvider` — for tests only.
 *
 * Analogous to `services/shopify/admin-context.server.ts`'s E2E auth-bypass
 * seam: a real AI vendor call can't run in an automated test (CLAUDE.md/
 * docs/product-intelligence.md — never a live provider call from a test),
 * but Product Intelligence's route → service → provider → validation →
 * persistence → UI path needs to be exercised end-to-end, not just up to
 * the point `UnconfiguredAIProvider` throws. This returns fixed, realistic,
 * schema-valid JSON instead of calling anything, so
 * `product-intelligence.server.ts` runs its real validation/persistence
 * logic against real (if canned) provider output.
 *
 * Lives here (not services/ai/) because it has Product-Intelligence-domain
 * knowledge (category recommendations) — services/ai/ stays vendor-generic
 * per CLAUDE.md's "AI providers are isolated" boundary; only
 * `services/intelligence/provider.server.ts` ever constructs this.
 *
 * Only ever selected by `provider.server.ts`'s `getConfiguredAIProvider()`
 * when `NODE_ENV === "test"` AND `AI_PROVIDER === "deterministic-test"` —
 * both required, neither set outside test config (see that file).
 */
import type { AIProvider, AnalyzeProductInput, ProductAnalysisRawOutput } from "../ai/types";
import { getCategoryRecommendation } from "./category-recommendations";

export class DeterministicTestAIProvider implements AIProvider {
  readonly name = "deterministic-test";

  async analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysisRawOutput> {
    const signal = [input.category, input.productType, input.title].filter(Boolean).join(" ");
    const recommendation = getCategoryRecommendation(signal);
    const category = input.category ?? input.productType ?? "General";

    return {
      category,
      subcategory: input.productType || null,
      productType: input.productType || null,

      material: null,
      primaryColor: null,
      secondaryColors: [],

      pattern: null,
      texture: null,
      style: null,

      useCases: [],
      targetAudience: null,
      genderSuitability: null,
      seasonality: [],
      pricePositioning: null,

      visualCharacteristics: { source: "deterministic-test-provider" },
      productDimensions: null,
      packagingCharacteristics: null,
      hardwareComponents: [],

      modelSuitable: recommendation.modelSuitable,
      recommendedModelAttributes: null,
      recommendedPoseTypes: recommendation.recommendedPoseTypes,

      recommendedEnvironments: recommendation.recommendedEnvironments,
      recommendedProps: [],
      recommendedPhotographyStyles: [],
      recommendedAssetTypes: recommendation.recommendedAssetTypes,

      identityAnchors: {
        category,
        shape: null,
        material: null,
        primaryColor: null,
        constructionDetails: [],
        distinctiveHardware: [],
        brandingVisible: false,
        brandingDescription: null,
      },
      imageAnalyses: input.images.map((image) => ({
        mediaId: image.mediaId,
        url: image.url,
        relevance: image.position === 0 ? "primary" : "secondary",
        qualityIndicators: null,
        identityObservations: [],
      })),

      confidence: 0.5,
    };
  }
}
