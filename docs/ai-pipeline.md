# AI pipeline

## Current state (Phase 4)

`services/ai/types.ts` defines three separate, focused provider
interfaces. `services/ai/unconfigured-provider.ts` provides an
`Unconfigured*` implementation of each, which satisfies its interface and
throws `UnconfiguredAIProviderError` on every call — still the default
for `AIProvider` and `ImageGenerationProvider` (no real vendor for
either), and for the three `ImageProcessingProvider` methods Phase 4
didn't implement.

- **`AIProvider`** — product analysis (`analyzeProduct`). Called by Phase
  2 (Product Intelligence) — see docs/product-intelligence.md. No real
  vendor.
- **`ImageGenerationProvider`** — generative image creation
  (`generateImage`). Called by Phase 3 (image generation foundation) —
  see docs/generation.md. No real vendor.
- **`ImageProcessingProvider`** — deterministic/transformative operations
  on an existing image (`removeBackground`, `enhance`, `upscale`,
  `generateShadow`, `crop`, `resize`). Established as an interface in
  Phase 3 (abstraction only); Phase 4 gave it a real implementation,
  `ProductionImageProcessingProvider`
  (`services/ai/production-image-processing-provider.server.ts`) — **the
  first real, working AI vendor call anywhere in this codebase**:
  `removeBackground` calls remove.bg; `enhance`/`resize` run locally via
  `sharp` (no vendor needed — see docs/image-processing.md "Provider
  selection" for why); `upscale`/`generateShadow`/`crop` still throw
  `UnconfiguredAIProviderError`. See docs/image-processing.md.

These are three interfaces, not one do-everything `AIProvider`, because
each is a genuinely different capability with a different input/output
shape and may end up backed by different vendors — see docs/generation.md
for why an earlier, single-interface draft (with `removeBackground`/
`enhanceImage`/`generateLifestyle`/`generateModelImage` all on one
`AIProvider`) was replaced.

Phase 2/3/4 are each the first caller of their own interface, and each
exercises the whole interface-first design (business logic depending on
the interface, not a vendor) in tests via a deterministic, network-free
test provider owned by that domain (`services/intelligence/`,
`services/generation/`, `services/processing/`) — real vendor code is
never reachable from a test, even for `ImageProcessingProvider`, which
does have one now.

## The interfaces

```ts
interface AIProvider {
  readonly name: string;
  analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysisRawOutput>;
}

interface ImageGenerationProvider {
  readonly name: string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

interface ImageProcessingProvider {
  readonly name: string;
  removeBackground(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  enhance(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  upscale(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  generateShadow(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  crop(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
  resize(input: ImageProcessingInput): Promise<ImageProcessingOutput>;
}
```

`analyzeProduct`, `generateImage`, and three of `ImageProcessingProvider`'s
six methods (`removeBackground`/`enhance`/`resize`) are the capabilities
actually called (by Phase 2, Phase 3, and Phase 4 respectively) — see
docs/product-intelligence.md, docs/generation.md, and
docs/image-processing.md for their input shapes and why each output type
is deliberately loose/untyped where a real vendor's response can't be
trusted structurally (validated separately, never trusted as-is).
`upscale`/`generateShadow`/`crop` remain unimplemented.

Each capability is a separate method (rather than one generic
"generate(prompt)" call) because each has a distinct, typed input/output
shape and may end up backed by different vendors or models.
`ImageGenerationProvider.generateImage` and `ImageProcessingProvider`'s
methods return raw image bytes (`Uint8Array`) plus content type — a
temporary, provider-owned artifact, never assumed to live anywhere in
particular; the caller persists it through `lib/storage/`'s
`StorageProvider` abstraction (see docs/generation.md "Storage").

## Rules for a real provider

- Lives in `services/ai/`, implements one of the interfaces above. No
  other module may import the vendor's SDK directly —
  `ProductionImageProcessingProvider` is the existing example: it's the
  only file that calls `fetch()` against remove.bg or imports `sharp`.
- Reads credentials only via `lib/validation/env.server.ts`
  (`AI_PROVIDER`/`AI_PROVIDER_API_KEY`/`AI_PROVIDER_BASE_URL` for
  analysis/generation; `IMAGE_PROCESSING_PROVIDER`/`REMOVE_BG_API_KEY`
  for processing) — never hardcoded, never logged (all in
  `SECRET_ENV_KEYS` where applicable).
- Never called from an automated test with real credentials or a real
  network request — see each domain's own double-gated deterministic
  test provider.

## Not yet designed (future phases)

- Which vendor(s) to integrate for image *generation* (still entirely
  unimplemented) or for `upscale`/`generateShadow`/`crop`
- Prompt/config construction beyond `PRODUCT_CLEANUP` (see
  docs/generation.md "Generation types" for which of the nine taxonomy
  values have dedicated plan-building logic today)
- Batch generation (batch *processing* exists — see
  docs/image-processing.md), additional aspect ratios beyond the three
  processing presets, generation/processing presets
- Cost/usage accounting per call (ties into the future `UsageRecord`
  model — see docs/database.md); Phase 3/4 record the structured
  metadata (provider, duration, output count, ...) a future phase would
  need, but compute no cost themselves
- Validating a generated/processed result against its identity anchors —
  both `identityAnchors` propagate all the way to the provider input
  specifically so a future phase can do this; nothing inspects output
  content against them yet
