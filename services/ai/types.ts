/**
 * AI provider abstraction.
 *
 * The app must never depend on a specific AI vendor's SDK/API shape outside
 * of that vendor's own provider implementation. Everything else — routes,
 * queue jobs, other services — depends on the `AIProvider` interface below.
 *
 * No provider implements this for real yet (see docs/ai-pipeline.md and
 * docs/product-intelligence.md) and nothing here makes network calls.
 * Capabilities are modeled as separate methods (rather than one generic
 * "generate" call) because each has a distinct input/output shape and may
 * end up backed by different vendors.
 */

export interface ImageRef {
  /** Storage key (see lib/storage) the image lives at, not a raw URL. */
  storageKey: string;
  contentType: string;
}

/**
 * One source product image, referenced by its Shopify-hosted CDN URL —
 * deliberately NOT an `ImageRef`. `ImageRef.storageKey` names a location in
 * *our own* storage (`lib/storage`); Shopify-hosted media is never that
 * (see CLAUDE.md "Storage rules" — Shopify-hosted images are never treated
 * as permanent application-owned assets). A provider implementation
 * decides for itself how to fetch/forward the URL — this interface only
 * carries the reference, never raw image bytes through the browser (see
 * docs/product-intelligence.md "Data sources").
 */
export interface ProductImageReference {
  /** Our internal `ShopifyProductMedia.id` — lets a provider's per-image
   * observations be correlated back to a specific media row. */
  mediaId: string;
  url: string;
  altText: string | null;
  position: number;
}

/**
 * Forward-looking and intentionally minimal — see
 * docs/product-intelligence.md "Brand style foundation". Not persisted,
 * not built out as a feature this phase; `analyzeProduct` accepting it now
 * just means a future generation stage won't need an interface change to
 * start passing one.
 */
export interface BrandStyleContext {
  visualTone?: string;
  colorPalette?: string[];
  photographyStyle?: string;
  backgroundStyle?: string;
  lightingStyle?: string;
  compositionStyle?: string;
  luxuryLevel?: string;
  modelStyle?: string;
}

/**
 * Structured product context an implementation grounds its analysis in.
 * Shopify (this data) and the product's original images are the source of
 * truth — see docs/product-intelligence.md "Identity preservation": a
 * provider must not invent or alter core identity (category, material,
 * color, shape, ...) beyond what this input genuinely supports.
 */
export interface AnalyzeProductInput {
  title: string;
  description: string;
  productType: string;
  category: string | null;
  vendor: string;
  tags: string[];
  images: ProductImageReference[];
  brandStyle?: BrandStyleContext | null;
}

/**
 * Raw output from `AIProvider.analyzeProduct` — deliberately loose
 * (`unknown`-shaped JSON), not the validated `ProductIntelligenceData`
 * shape. A provider is untrusted input: `services/intelligence/schema.ts`'s
 * `ProductIntelligenceSchema` validates it before anything is persisted or
 * shown to a merchant — see CLAUDE.md "Reject malformed provider output".
 * This type exists (rather than plain `unknown`) purely to document that
 * intent at the call site.
 */
export type ProductAnalysisRawOutput = Record<string, unknown>;

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
 * see docs/ai-pipeline.md. `analyzeProduct` is the one capability Phase 2
 * (Product Intelligence) actually calls; the rest remain unimplemented
 * abstractions until the phases that need them (image generation).
 */
export interface AIProvider {
  readonly name: string;

  analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysisRawOutput>;
  removeBackground(input: RemoveBackgroundInput): Promise<RemoveBackgroundResult>;
  enhanceImage(input: EnhanceImageInput): Promise<EnhanceImageResult>;
  generateLifestyle(input: GenerateLifestyleInput): Promise<GenerateLifestyleResult>;
  generateModelImage(input: GenerateModelImageInput): Promise<GenerateModelImageResult>;
}
