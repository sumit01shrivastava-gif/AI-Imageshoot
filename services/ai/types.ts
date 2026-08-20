/**
 * AI provider abstractions.
 *
 * The app must never depend on a specific AI vendor's SDK/API shape outside
 * of that vendor's own provider implementation. Everything else — routes,
 * queue jobs, other services — depends on the interfaces below.
 *
 * Three separate, focused interfaces, not one do-everything `AIProvider`:
 *
 *   - `AIProvider` — product analysis (`analyzeProduct`, Phase 2).
 *   - `ImageGenerationProvider` — generative image creation (`generateImage`,
 *     Phase 3). A brand-new image that didn't exist before the call.
 *   - `ImageProcessingProvider` — deterministic/transformative operations
 *     (background removal, enhance, upscale, ...). Image generation and
 *     image processing are NOT the same thing: generation is creative and
 *     provider/model-dependent; processing is a deterministic transform of
 *     an existing image. Conflating them into one capability method (as an
 *     earlier draft of this interface did, with `removeBackground`/
 *     `enhanceImage`/`generateLifestyle`/`generateModelImage` all on one
 *     `AIProvider`) made it impossible to reason about or test the two
 *     independently — see docs/generation.md "Provider abstraction".
 *
 * No provider implements any of these for real yet (see docs/ai-pipeline.md,
 * docs/product-intelligence.md, docs/generation.md) and nothing here makes
 * network calls. Capabilities are modeled as separate methods (rather than
 * one generic "generate" call) because each has a distinct input/output
 * shape and may end up backed by different vendors.
 */

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

/**
 * Capability surface for product analysis. `analyzeProduct` is the one
 * capability Phase 2 (Product Intelligence) calls — see
 * docs/product-intelligence.md.
 */
export interface AIProvider {
  readonly name: string;
  analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysisRawOutput>;
}

// ---------------------------------------------------------------------------
// ImageGenerationProvider (Phase 3) — creative, generative image creation.
// See docs/generation.md "Provider abstraction".
// ---------------------------------------------------------------------------

/**
 * Attributes of the source product that must NOT be reinterpreted or
 * altered by generation — category, material, primary color, construction
 * details, distinctive hardware, branding, ... This interface deliberately
 * does not import Product Intelligence's `IdentityAnchors` type (that
 * would be `services/ai/` depending on a higher domain layer — see
 * CLAUDE.md's domain boundaries); it only requires "some structured
 * object", leaving the concrete shape to the caller
 * (`services/generation/` — see docs/generation.md "Identity preservation").
 */
export type ProductFacts = Record<string, unknown>;

/**
 * The part of a generation request that MAY vary between generations of
 * the same product — scene, lighting, composition, and the free-text
 * prompt synthesized from them. Never merchant-supplied raw text — see
 * docs/generation.md "No arbitrary prompts".
 */
export interface CreativeDirection {
  prompt: string;
  negativeConstraints?: string[];
  environment?: string | null;
  lighting?: string | null;
  composition?: string | null;
}

export type OutputFormat = "png" | "jpeg" | "webp";
export type GenerationQuality = "draft" | "standard" | "high";

export interface GenerateImageInput {
  /** The generation taxonomy value this request belongs to (e.g.
   * "PRODUCT_CLEANUP", "LIFESTYLE") — kept as a plain string here so this
   * interface doesn't depend on `services/generation`'s or Prisma's enum. */
  generationType: string;
  sourceImages: ProductImageReference[];
  productFacts: ProductFacts;
  creativeDirection: CreativeDirection;
  aspectRatio: string;
  outputFormat: OutputFormat;
  quality: GenerationQuality;
  /** How many output images this request wants. */
  outputCount: number;
  /** Which attempt of this generation job this call represents (1 = first
   * attempt) — lets a provider treat retries idempotently and lets the
   * deterministic test provider simulate "fails once, then succeeds" for
   * retry tests. See docs/generation.md "Retry semantics". */
  attempt: number;
  brandStyle?: BrandStyleContext | null;
}

export interface GeneratedImageOutput {
  /** Raw image bytes — a temporary, provider-owned artifact. The caller
   * (services/generation/job.server.ts) persists this through the existing
   * `StorageProvider` abstraction; this interface never assumes where the
   * bytes end up. See docs/generation.md "Storage". */
  data: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
  /** The provider's own id for this specific output, if it has one. */
  providerResultId?: string;
  metadata?: Record<string, unknown>;
}

export interface GenerateImageResult {
  outputs: GeneratedImageOutput[];
  /** The provider's own id for the overall generation call/job, if it has
   * one (some vendors are themselves async and return a job id to poll). */
  providerJobId?: string;
  /** Raw provider response, kept only for the caller to store for
   * debugging — never trusted or parsed beyond `outputs` above. */
  raw?: unknown;
}

export interface ImageGenerationProvider {
  readonly name: string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

// ---------------------------------------------------------------------------
// ImageProcessingProvider (Phase 3, abstraction + contracts only) —
// deterministic/transformative operations on an existing image. See
// docs/generation.md "Processing abstraction". No implementation (real or
// test) is wired up this phase — establishing the interface is the goal.
// ---------------------------------------------------------------------------

export interface ImageProcessingInput {
  sourceImage: ProductImageReference;
  /** Operation-specific options (e.g. target dimensions for `resize`,
   * crop bounds for `crop`) — left loose since each operation's shape
   * differs and none are implemented yet. */
  options?: Record<string, unknown>;
}

export interface ImageProcessingOutput {
  data: Uint8Array;
  contentType: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
}

export interface ImageProcessingProvider {
  readonly name: string;
  removeBackground(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  enhance(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  upscale(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  generateShadow(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  crop(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  resize(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
}
