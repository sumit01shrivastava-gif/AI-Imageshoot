/**
 * Placeholder providers that make zero network calls.
 *
 * Used as the default for each of the three AI-capability interfaces
 * (`AIProvider`, `ImageGenerationProvider`, `ImageProcessingProvider`)
 * until a real vendor is selected and configured (see docs/ai-pipeline.md,
 * docs/product-intelligence.md, docs/generation.md). Also useful directly
 * in tests: each satisfies its interface so calling code can be
 * type-checked and unit tested against the abstraction without ever
 * reaching a real AI API.
 */
import type {
  AIProvider,
  AnalyzeProductInput,
  GenerateImageInput,
  GenerateImageResult,
  ImageGenerationProvider,
  ImageProcessingInput,
  ImageProcessingOutput,
  ImageProcessingProvider,
  ProductAnalysisRawOutput,
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

  // Parameter stays named (not `_input`) and explicitly `void`-ed rather
  // than dropped, so the signature stays self-documenting and satisfies
  // `AIProvider` without an unused-variable lint exception.
  async analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysisRawOutput> {
    void input;
    throw new UnconfiguredAIProviderError("analyzeProduct");
  }
}

export class UnconfiguredImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "unconfigured";

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    void input;
    throw new UnconfiguredAIProviderError("generateImage");
  }
}

export class UnconfiguredImageProcessingProvider implements ImageProcessingProvider {
  readonly name = "unconfigured";

  async removeBackground(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("removeBackground");
  }

  async enhance(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("enhance");
  }

  async upscale(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("upscale");
  }

  async generateShadow(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("generateShadow");
  }

  async crop(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("crop");
  }

  async resize(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("resize");
  }
}
