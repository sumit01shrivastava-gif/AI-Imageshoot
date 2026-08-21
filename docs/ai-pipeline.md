# AI pipeline

## Current state

(Originally written for Phase 4; updated for the commercial-readiness
pass that added real image-to-image/edit support, a real LLM-backed
intent parser, and credit-cost accounting — see docs/creative-studio.md,
docs/usage.md, docs/billing.md.)

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
  see docs/generation.md. `ProductionImageGenerationProvider`
  (`services/ai/production-image-generation-provider.server.ts`) is a
  real, testable HTTP client against a vendor-agnostic, "OpenAI Images
  API-compatible" contract — selected only when `AI_PROVIDER_BASE_URL`/
  `AI_PROVIDER_API_KEY` are configured; `UnconfiguredImageGenerationProvider`
  remains the default. No live vendor account is configured in this
  environment, so every generation still runs through the deterministic
  test provider in practice. **Now supports two request shapes**, not
  just text-to-image — see "Image-to-image / editing contract" below.
- **`IntentParsingProvider`** (Creative Studio pass) — turns a merchant's
  natural-language message into a structured instruction
  (`parseIntent`). Called by `services/creative-studio/` — see
  docs/creative-studio.md. `HeuristicIntentParser`
  (`services/ai/heuristic-intent-parser.ts`) is a real, rule-based,
  ALWAYS-ON default — not gated behind `NODE_ENV==="test"` — since the
  Creative Studio needs a genuinely working interpretation step even
  with no AI vendor configured. **A real-LLM implementation now exists
  too** —`ProductionIntentParsingProvider`
  (`services/ai/production-intent-parser.server.ts`), selected by
  `services/creative-studio/provider.server.ts`'s resolver whenever
  `AI_PROVIDER_BASE_URL`/`AI_PROVIDER_API_KEY` are configured, wrapped in
  a `FallbackIntentParser` that falls back to the heuristic parser on
  any failure. Tests never configure those env vars, so they always
  exercise the heuristic parser (CLAUDE.md "Never make a real AI API
  call from a test").
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

## Image-to-image / editing contract

`ProductionImageGenerationProvider.generateImage` picks one of two
request shapes based on `GenerateImageInput.mode`
(`services/ai/types.ts`'s `GenerationMode`):

- **`TEXT_TO_IMAGE`/absent** (every pre-Creative-Studio generationType,
  unchanged) → `POST {baseUrl}/v1/images/generations` — `prompt`/`n`/
  `size`/`quality`/`response_format`, no reference image.
- **`IMAGE_TO_IMAGE`/`IMAGE_EDIT`/`VARIATION`** (Creative Studio's
  conversational edits, whenever at least one reference/source image is
  available) → `POST {baseUrl}/v1/images/edits` — the same fields, PLUS
  the reference image(s), fetched and base64-encoded, as `image` (one
  reference) or `images[]` (more than one) — this app's own superset of
  OpenAI's single-image-only edits endpoint, since several modern
  editing models genuinely accept multiple references. Which images are
  sent, and in what priority, is `resolveReferenceImageUrls`'s job:
  `GenerateImageInput.referenceImages` (explicit references — e.g. the
  exact prior result a follow-up is editing forward from) win when
  present; `sourceImages` (the original product photos) are the
  fallback.

**Model selection** is mode-aware: `AI_IMAGE_EDIT_MODEL` for an editing
request, `AI_IMAGE_GENERATION_MODEL` for a fresh one, both falling back
to `AI_PROVIDER_MODEL` when unset — many real vendors run editing on a
materially different model than fresh generation, so this is a genuine
distinction, not just two names for the same setting.

A reference-image fetch failure (this app's own storage, not the
vendor) surfaces as `ProviderResponseError`, not a raw exception —
merchant-safe error mapping happens the same way as every other provider
failure (see docs/generation.md "Error handling").

## Rules for a real provider

- Lives in `services/ai/`, implements one of the interfaces above. No
  other module may import the vendor's SDK directly —
  `ProductionImageProcessingProvider` is the existing example: it's the
  only file that calls `fetch()` against remove.bg or imports `sharp`.
- Reads credentials only via `lib/validation/env.server.ts`
  (`AI_PROVIDER`/`AI_PROVIDER_API_KEY`/`AI_PROVIDER_BASE_URL`/
  `AI_PROVIDER_MODEL`/`AI_PROVIDER_TIMEOUT_MS` for analysis/generation/
  intent parsing, plus `AI_IMAGE_GENERATION_MODEL`/`AI_IMAGE_EDIT_MODEL`
  for mode-specific model selection — see "Image-to-image / editing
  contract" above; `IMAGE_PROCESSING_PROVIDER`/`REMOVE_BG_API_KEY` for
  processing) — never hardcoded, never logged (all in `SECRET_ENV_KEYS`
  where applicable).
- Never called from an automated test with real credentials or a real
  network request — see each domain's own double-gated deterministic
  test provider.

## Not yet designed / explicitly deferred

- **No specific commercial vendor is named or credentialed anywhere in
  this repository.** `ProductionImageGenerationProvider`/
  `ProductionIntentParsingProvider` are real, working HTTP clients
  against documented, vendor-agnostic JSON contracts — a merchant with
  an endpoint speaking either contract gets a genuinely working
  integration with zero code changes — but no live vendor account exists
  in this environment, so every generation/intent-parse in this
  environment still runs through the deterministic/heuristic providers
  in practice. A vendor with a materially different wire shape needs its
  own adapter file behind the same interface.
- `upscale`/`generateShadow`/`crop` (`ImageProcessingProvider`) remain
  unimplemented.
- Cost/usage accounting per call is now real — see docs/usage.md's
  credit-cost rule and docs/billing.md's plan catalog — but the
  PER-PLAN resolution/output-count/batch-size LIMITS in
  `services/billing/plans.ts` are stated policy, not yet enforced by any
  request-side clamp (see docs/billing.md "Known limitations").
- Validating a generated/processed result against its identity anchors —
  both `identityAnchors` propagate all the way to the provider input
  specifically so a future phase can do this; nothing inspects output
  content against them yet (`services/generation/identity-validation.server.ts`
  returns an honest "not yet possible" result — see docs/creative-studio.md
  "Identity preservation").
