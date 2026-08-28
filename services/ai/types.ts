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

/**
 * How this request relates to a source image — see
 * services/creative-studio/types.ts's `GenerationModeValue` (this type
 * mirrors it structurally without importing it, per this file's own
 * "no higher-domain import" rule). Optional and additive: every
 * generationType that existed before the Creative Studio (PRODUCT_CLEANUP,
 * LIFESTYLE, ...) never sets this, and a provider must treat its absence
 * exactly as it always has — plain text-to-image grounded by
 * `sourceImages`.
 */
export type GenerationMode = "TEXT_TO_IMAGE" | "IMAGE_TO_IMAGE" | "IMAGE_EDIT" | "VARIATION";

/**
 * One additional reference image beyond `sourceImages` — e.g. the exact
 * prior generation result a conversational follow-up is editing forward
 * from. `role` tells a provider capable of multi-reference conditioning
 * which reference is "the ground-truth original product" vs. "the
 * in-progress composition to edit," without this interface needing to
 * know why (services/ai/ stays domain-agnostic — see CLAUDE.md's
 * architecture principles). A provider that doesn't support multi
 * -reference editing may ignore this and fall back to `sourceImages` +
 * `creativeDirection.prompt` alone.
 */
export interface GenerationReferenceImage {
  url: string;
  role: "product_original" | "previous_result" | "style_reference";
}

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
  /** The shop's real plan resolution ceiling, in pixels on the long
   * edge — resolved server-side from the shop's actual subscription
   * (never merchant-supplied), snapshotted onto the `GenerationPlan` at
   * job-creation time (see services/generation/schema.ts's
   * `maxResolutionPx` doc comment). A provider MUST clamp its own
   * output size to this ceiling rather than silently generating a
   * larger image and reporting success — see
   * services/ai/openai-image-provider.server.ts's `sizeForAspectRatio`
   * for the concrete mapping. `undefined`/`null` falls back to the
   * provider's own default ceiling (e.g. for a `GenerateImageInput`
   * built outside the plan pipeline, such as a unit test). */
  maxResolutionPx?: number | null;
  /** Which attempt of this generation job this call represents (1 = first
   * attempt) — lets a provider treat retries idempotently and lets the
   * deterministic test provider simulate "fails once, then succeeds" for
   * retry tests. See docs/generation.md "Retry semantics". */
  attempt: number;
  brandStyle?: BrandStyleContext | null;
  /** Structured, generation-type-specific scene detail (e.g. Phase 5's
   * lifestyle scene: surface, props, camera angle, mood, color direction)
   * — deliberately generic (`Record<string, unknown>`), mirroring
   * `productFacts`'s existing pattern: `services/ai/` must not import a
   * higher domain layer's concrete shape (see CLAUDE.md's domain
   * boundaries and docs/lifestyle-generation.md "Provider strategy").
   * The caller (`services/generation/build-input.ts`) is the "provider
   * adapter" that flattens its own structured plan into this; a real
   * provider implementation decides how (or whether) to use it — folded
   * into its own prompt construction, or passed as structured params if
   * the vendor's API accepts them. `undefined`/absent for generation
   * types with no scene concept (e.g. PRODUCT_CLEANUP). */
  sceneDetails?: Record<string, unknown>;
  /** See `GenerationMode`'s doc comment. Absent for every pre-existing
   * generationType (unchanged behavior); the Creative Studio always sets
   * one (services/creative-studio/build-input.ts). */
  mode?: GenerationMode;
  /** See `GenerationReferenceImage`'s doc comment. Absent for every
   * pre-existing generationType. */
  referenceImages?: GenerationReferenceImage[];
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
  /** Ephemeral, worker-lifetime canonical references that a post-generation
   * evaluator may reuse. Never persisted as result metadata or sent to a
   * browser. Providers omit this when they did not prepare references. */
  qualityReferenceImages?: QualityReferenceImage[];
}

export interface ImageGenerationProvider {
  readonly name: string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

// ---------------------------------------------------------------------------
// VisualQualityEvaluator — post-generation image assessment.
//
// Kept separate from ImageGenerationProvider: generation and criticism have
// different cost, failure, and model-selection characteristics. The
// generation domain owns the deterministic policy applied to this evidence;
// providers only return constrained visual observations.
// ---------------------------------------------------------------------------

export interface QualityReferenceImage {
  url?: string;
  data?: Uint8Array;
  contentType?: string;
  role: "product_original" | "previous_result" | "style_reference";
}

export interface VisualQualityEvaluationInput {
  generatedImage: { data: Uint8Array; contentType: string };
  references: QualityReferenceImage[];
  /** Compact resolved brief only. Never the raw conversation or provider prompt. */
  qualityBrief: Record<string, unknown>;
}

export type VisualQualityDimension =
  | "productFidelity"
  | "briefAdherence"
  | "creativeConcept"
  | "artDirection"
  | "photographyRealism"
  | "composition"
  | "commercialUsefulness"
  | "designExecution"
  | "physicalIntegrity"
  | "channelSuitability";

export type VisualQualityCriticalFailure =
  | "PRODUCT_MISMATCH"
  | "BRIEF_CONTRADICTION"
  | "PHYSICAL_INTEGRITY_FAILURE"
  | "FORMAT_FAILURE"
  | "INVENTED_BRANDING_OR_TEXT";

export interface VisualQualityEvaluationRaw {
  dimensions: Record<VisualQualityDimension, number>;
  criticalFailures: VisualQualityCriticalFailure[];
  observations: string[];
  correctionGuidance: string[];
  confidence: number;
  evaluatorMetadata?: Record<string, unknown>;
}

export interface VisualQualityEvaluator {
  readonly name: string;
  evaluate(input: VisualQualityEvaluationInput): Promise<VisualQualityEvaluationRaw>;
}

// ---------------------------------------------------------------------------
// IntentParsingProvider (Creative Studio) — turns a merchant's natural
// -language message into a structured instruction. See
// docs/creative-studio.md "Intent model" and Part 3's requirement: "Do
// this through a provider-agnostic abstraction so a future/real AI model
// can perform intent parsing without coupling the rest of the application
// to one vendor." Deliberately its own interface, not folded into
// `AIProvider`/`ImageGenerationProvider` — parsing a sentence into
// structure and generating a photorealistic image are unrelated
// capabilities that may end up backed by entirely different vendors (a
// small/cheap language model for the former, a large image model for the
// latter), mirroring this file's own module doc comment's reasoning for
// why AIProvider/ImageGenerationProvider/ImageProcessingProvider are
// three interfaces, not one.
// ---------------------------------------------------------------------------

/** Everything a parser needs to interpret one message — deliberately
 * loose/generic (`Record<string, unknown>` for `creativeContext`) so this
 * interface doesn't import services/creative-studio's concrete types
 * (this file must stay the lowest-level, domain-agnostic layer — see
 * CLAUDE.md's architecture principles). The caller
 * (services/creative-studio/) is the one place that knows the concrete
 * shape on both sides of this call. */
export interface ParseIntentInput {
  /** The merchant's own raw message — the ONLY place in the whole
   * Creative Studio pipeline this raw text is allowed to reach; a parser
   * implementation may read it, but nothing downstream of the parser's
   * structured output ever sees it again (see docs/creative-studio.md "No
   * arbitrary prompts"). */
  message: string;
  /** A compact summary of where the conversation currently stands (active
   * scene/style, whether a current result exists, recent instructions,
   * ...) — see services/creative-studio/creative-context.ts's
   * `CreativeContext`, serialized to a plain object for this boundary.
   * Lets a parser resolve short, context-dependent follow-ups
   * ("brighter", "use the second one") without needing the full raw
   * conversation history. */
  creativeContext: Record<string, unknown>;
  /** How many candidate prior results exist to reference by ordinal
   * ("use the second one") — 0 when this is the session's first message. */
  candidateResultCount: number;
  /**
   * Fetchable URLs of the reference image(s) relevant to THIS turn —
   * the same set of URLs `GenerateImageInput.referenceImages` would use
   * for the actual generation call (an uploaded photo, and/or the
   * session's own previous result) — so a real, multimodal-capable
   * `IntentParsingProvider` can genuinely SEE what it's reasoning about
   * (identity, pose, clothing, background, ...) instead of only reading
   * a text description of it. Empty for a from-scratch request with no
   * reference image, or when the configured parser has no vision
   * capability to make use of it — the heuristic parser
   * (services/ai/heuristic-intent-parser.ts) always ignores this field,
   * honestly: it does no image reasoning of any kind. Only ever an
   * already-durable signed/storage URL server-side has already resolved
   * — never a client-supplied one, same trust boundary as
   * `GenerateImageInput.referenceImages`.
   */
  referenceImageUrls?: string[];
}

/** Raw output from `IntentParsingProvider.parseIntent` — deliberately
 * loose (`unknown`), validated by
 * services/creative-studio/intent-schema.ts's `parseParsedIntent` before
 * anything downstream trusts it (see CLAUDE.md "Reject malformed provider
 * output"), the same pattern `ProductAnalysisRawOutput` already
 * establishes for `AIProvider.analyzeProduct`. */
export type ParsedIntentRawOutput = Record<string, unknown>;

export interface IntentParsingProvider {
  readonly name: string;
  parseIntent(input: ParseIntentInput): Promise<ParsedIntentRawOutput>;
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
