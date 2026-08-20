/**
 * Placeholder AIProvider that makes zero network calls.
 *
 * Used as the default provider until a real one is selected and configured
 * (see docs/ai-pipeline.md, docs/product-intelligence.md). Also useful
 * directly in tests: it satisfies the AIProvider interface so calling code
 * can be type-checked and unit tested against the abstraction without ever
 * reaching a real AI API.
 */
import type {
  AIProvider,
  AnalyzeProductInput,
  EnhanceImageInput,
  EnhanceImageResult,
  GenerateLifestyleInput,
  GenerateLifestyleResult,
  GenerateModelImageInput,
  GenerateModelImageResult,
  ProductAnalysisRawOutput,
  RemoveBackgroundInput,
  RemoveBackgroundResult,
} from "./types";

export class UnconfiguredAIProviderError extends Error {
  constructor(capability: string) {
    super(
      `AI provider is not configured — cannot call "${capability}". ` +
        `No AI vendor has been selected yet.`,
    );
    this.name = "UnconfiguredAIProviderError";
  }
}

export class UnconfiguredAIProvider implements AIProvider {
  readonly name = "unconfigured";

  // Every method below intentionally ignores its input — there's nothing
  // to call. Parameters are still named (not `_input`) and explicitly
  // `void`-ed rather than dropped, so each signature stays self-documenting
  // and satisfies `AIProvider` without an unused-variable lint exception.

  async analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysisRawOutput> {
    void input;
    throw new UnconfiguredAIProviderError("analyzeProduct");
  }

  async removeBackground(input: RemoveBackgroundInput): Promise<RemoveBackgroundResult> {
    void input;
    throw new UnconfiguredAIProviderError("removeBackground");
  }

  async enhanceImage(input: EnhanceImageInput): Promise<EnhanceImageResult> {
    void input;
    throw new UnconfiguredAIProviderError("enhanceImage");
  }

  async generateLifestyle(input: GenerateLifestyleInput): Promise<GenerateLifestyleResult> {
    void input;
    throw new UnconfiguredAIProviderError("generateLifestyle");
  }

  async generateModelImage(input: GenerateModelImageInput): Promise<GenerateModelImageResult> {
    void input;
    throw new UnconfiguredAIProviderError("generateModelImage");
  }
}
