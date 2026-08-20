/**
 * Placeholder AIProvider that makes zero network calls.
 *
 * Used as the default provider until a real one is selected and configured
 * (see docs/ai-pipeline.md). Also useful directly in tests: it satisfies the
 * AIProvider interface so calling code can be type-checked and unit tested
 * against the abstraction without ever reaching a real AI API.
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
  ProductAnalysis,
  RemoveBackgroundInput,
  RemoveBackgroundResult,
} from "./types";

export class UnconfiguredAIProviderError extends Error {
  constructor(capability: string) {
    super(
      `AI provider is not configured — cannot call "${capability}". ` +
        `This is expected in Phase 0: no AI provider has been selected yet.`,
    );
    this.name = "UnconfiguredAIProviderError";
  }
}

export class UnconfiguredAIProvider implements AIProvider {
  readonly name = "unconfigured";

  async analyzeProduct(_input: AnalyzeProductInput): Promise<ProductAnalysis> {
    throw new UnconfiguredAIProviderError("analyzeProduct");
  }

  async removeBackground(_input: RemoveBackgroundInput): Promise<RemoveBackgroundResult> {
    throw new UnconfiguredAIProviderError("removeBackground");
  }

  async enhanceImage(_input: EnhanceImageInput): Promise<EnhanceImageResult> {
    throw new UnconfiguredAIProviderError("enhanceImage");
  }

  async generateLifestyle(_input: GenerateLifestyleInput): Promise<GenerateLifestyleResult> {
    throw new UnconfiguredAIProviderError("generateLifestyle");
  }

  async generateModelImage(_input: GenerateModelImageInput): Promise<GenerateModelImageResult> {
    throw new UnconfiguredAIProviderError("generateModelImage");
  }
}
