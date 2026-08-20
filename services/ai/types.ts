/**
 * AI provider abstraction.
 *
 * The app must never depend on a specific AI vendor's SDK/API shape outside
 * of that vendor's own provider implementation. Everything else — routes,
 * queue jobs, other services — depends on the `AIProvider` interface below.
 *
 * No provider implements this yet (see docs/ai-pipeline.md) and nothing
 * here makes network calls. Capabilities are modeled as separate methods
 * (rather than one generic "generate" call) because each has a distinct
 * input/output shape and may end up backed by different vendors.
 */

export interface ImageRef {
  /** Storage key (see lib/storage) the image lives at, not a raw URL. */
  storageKey: string;
  contentType: string;
}

export interface ProductAnalysis {
  /** Free-form tags/attributes the provider inferred from the image(s). */
  tags: string[];
  /** Provider's plain-text description of the product, if it returns one. */
  description?: string;
  /** 0–1 confidence, when the provider exposes one. */
  confidence?: number;
}

export interface AnalyzeProductInput {
  images: ImageRef[];
  /** Optional merchant-provided context (title, category, ...) to ground the analysis. */
  productContext?: string;
}

export interface RemoveBackgroundInput {
  image: ImageRef;
}

export interface RemoveBackgroundResult {
  image: ImageRef;
}

export interface EnhanceImageInput {
  image: ImageRef;
  /** Provider-defined enhancement preset name (e.g. "sharpen", "denoise"). Left loose deliberately — presets are a later phase. */
  preset?: string;
}

export interface EnhanceImageResult {
  image: ImageRef;
}

export interface GenerateLifestyleInput {
  sourceImage: ImageRef;
  /** Free-text description of the desired scene/environment. */
  prompt: string;
  aspectRatio?: string;
}

export interface GenerateLifestyleResult {
  images: ImageRef[];
}

export interface GenerateModelImageInput {
  sourceImage: ImageRef;
  /** Free-text description of the desired AI model/pose. */
  prompt: string;
  aspectRatio?: string;
}

export interface GenerateModelImageResult {
  images: ImageRef[];
}

/**
 * Capability surface every AI provider implementation must satisfy.
 * Concrete providers (and the actual vendor selected) are a later phase —
 * see docs/ai-pipeline.md.
 */
export interface AIProvider {
  readonly name: string;

  analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysis>;
  removeBackground(input: RemoveBackgroundInput): Promise<RemoveBackgroundResult>;
  enhanceImage(input: EnhanceImageInput): Promise<EnhanceImageResult>;
  generateLifestyle(input: GenerateLifestyleInput): Promise<GenerateLifestyleResult>;
  generateModelImage(input: GenerateModelImageInput): Promise<GenerateModelImageResult>;
}
