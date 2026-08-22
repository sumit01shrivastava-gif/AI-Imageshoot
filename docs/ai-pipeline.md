# AI pipeline

## Provider selection (live-deployment pass)

**Selected: OpenAI's `gpt-image-1`**, via `services/ai/openai-image-provider.server.ts`
(`AI_PROVIDER=openai`). Evaluated against the criteria this pass's
instructions specified — photorealism, image-to-image editing, reference
-image input (including multiple references in one edit call), product/
text/logo preservation, material and lighting realism, resolution,
commercial-photography suitability, and predictable, well-documented
production API behavior:

- **Genuinely strong at commercial product photography.** gpt-image-1 is
  widely regarded (as of this pass's research) as one of the strongest
  generally-available models for photorealistic, prompt-adherent
  ecommerce/product imagery specifically — including accurate text/logo
  rendering, which matters for packaging and branding this app is
  explicitly trying to preserve.
- **Real, native multi-reference image editing.** `/v1/images/edits`
  accepts more than one input image in a single request — directly
  useful for Creative Studio instructions like "use the second image as
  reference" or "keep the product but match this background," not just
  a single before/after edit.
- **The most standard, best-documented REST API in this space** — a
  plain API-key-authenticated HTTPS endpoint, no SDK required, well
  -specified request/response shapes, predictable error codes. Given
  this environment has no live vendor account to test against, choosing
  the vendor with the most precisely documented wire contract (rather
  than one this session would have to guess at from memory) was itself
  a reliability consideration — see the module doc comment for the
  specific documented behaviors this adapter implements (quality enum,
  fixed size options, no `response_format`, etc.).
- **Simple, single-credential setup** — one API key, no separate base
  URL/region/project configuration required to get started, which
  matters for "here's exactly what credential to add" being a short,
  unambiguous list (see docs/production-deployment.md).

**Considered and not selected this pass**: Google's Gemini 2.5 Flash
Image ("nano-banana") is a credible, frequently-cited alternative,
particularly strong at instruction-following multi-turn edits and
subject consistency — genuinely worth evaluating for a future pass or
as a second registered provider. Not selected now because doing so well
would mean implementing and documenting a SECOND full adapter+contract
without being able to live-test either against a real account in this
environment; shipping one real, thoroughly-documented, testable
adapter was judged more valuable than two speculative ones. The
provider-agnostic architecture (`ImageGenerationProvider`) means adding
it later is additive — a new file, a new `AI_PROVIDER` value in the
resolver — never a rewrite.

The existing generic, vendor-agnostic "OpenAI-Images-API-compatible"
JSON contract (`ProductionImageGenerationProvider`) remains available
for a self-hosted or differently-branded endpoint that speaks that
shape (`AI_PROVIDER` set to anything other than `"openai"`, with
`AI_PROVIDER_BASE_URL` also set) — see "The interfaces" below for the
resolver's exact four-way selection.

## Current state

(Originally written for Phase 4; updated for the commercial-readiness
pass that added real image-to-image/edit support, a real LLM-backed
intent parser, and credit-cost accounting — see docs/creative-studio.md,
docs/usage.md, docs/billing.md — and this live-deployment pass, which
selected and implemented a real commercial vendor, OpenAI, on top of
that foundation.)

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
  see docs/generation.md. Four-way resolver
  (`services/generation/provider.server.ts`):
  `OpenAIImageGenerationProvider` (`services/ai/openai-image-provider.server.ts`,
  `AI_PROVIDER=openai` — see "Provider selection" above, the real
  selected commercial vendor) → `ProductionImageGenerationProvider`
  (`services/ai/production-image-generation-provider.server.ts`, the
  generic vendor-agnostic contract, for any other `AI_PROVIDER` value
  with a base URL) → `UnconfiguredImageGenerationProvider` (default,
  throws a clear error). No live vendor account is configured in THIS
  development environment (see docs/production-deployment.md for what
  a real deployment needs), so generation still runs through the
  deterministic test provider in this repo's own test/dev runs — but
  the real adapter is genuinely implemented, tested, and ready to run
  the moment `AI_PROVIDER_API_KEY` is set to a real key. **Supports two
  request shapes**, not just text-to-image — see "Image-to-image /
  editing contract" below (applies to both real adapters, with
  vendor-specific wire-format differences — see
  `openai-image-provider.server.ts`'s own doc comment for exactly how
  OpenAI's real contract differs from the generic one).
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

This section describes the GENERIC, vendor-agnostic contract
(`ProductionImageGenerationProvider`, `AI_PROVIDER` set to anything
other than `"openai"`). The real, selected OpenAI adapter
(`OpenAIImageGenerationProvider`) follows the same two-request-shape
IDEA but speaks OpenAI's actual different wire format — see that file's
own module doc comment for the specific, real differences (multipart
`/v1/images/edits`, no `response_format`, a `low`/`medium`/`high`/`auto`
quality enum, three fixed canvas sizes). Both providers share one prompt
-composition helper, `services/ai/prompt-composition.ts`'s
`composeProviderPrompt`/`composeProductGroundingPrefix` — see "Provider
-input composition" below.

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

## Provider-input composition

### The explicit prompt hierarchy

Every real provider call's final text follows the same documented,
intentional order — never the merchant's raw message concatenated with
whatever else happened to be handy:

1. **Product identity / immutable characteristics** — stated FIRST,
   ahead of any creative direction, so the constraint anchors the
   request rather than reading as an afterthought a model might weight
   less once a wall of scene/style description precedes it
   (`services/creative-studio/identity-constraints.ts`'s
   `buildIdentityConstraints`, `services/generation/build-plan.ts`'s
   `PRESERVE_PRODUCT_INSTRUCTION` — both now lead their respective
   `creativeDirection.prompt`, not trail it).
2. **Reference-image fidelity** — an explicit "use this exact image as
   the starting point" clause, only present for a Creative Studio
   IMAGE_TO_IMAGE/IMAGE_EDIT/VARIATION turn (`plan-builder.ts`'s
   `synthesizeCreativePrompt`) — never silently omitted when a
   reference image exists (see docs/creative-studio.md "Image-to-image
   flow").
3. **Product facts** — `composeProductGroundingPrefix` (below):
   title/category/description, what the product actually IS.
4. **The user-requested creative transformation** — intent framing +
   scene/style/add/remove/creative-overrides.
5–6. **Composition/environment and lighting/camera/color direction** —
   folded into the same clause list as 4 (one natural sentence, not
   artificially split).
7. **Output requirements** — resolution/quality/output-count are real
   API parameters (`size`/`quality`/`n`), never restated as prose a
   model could contradict; negative constraints are the one exception,
   stated explicitly as an "Avoid: ..." clause.

This hierarchy is category-agnostic by construction — nothing here
special-cases cosmetics vs. electronics vs. jewelry; the SAME structure
is populated from whatever Product Intelligence actually determined for
that product (its real category, material, identity anchors), so the
resulting prompt adapts per-product without any hardcoded per-category
branch to maintain.

`services/ai/prompt-composition.ts` is the ONE place the final text sent
to a real vendor is assembled from a `GenerateImageInput`, shared by
both real providers (never duplicated per-vendor):

- `composeProductGroundingPrefix(productFacts)` — a short "Product:
  {title} ({type}). {description}" prefix built from
  `GenerationPlan.productFacts.title`/`description`/`attributes` (see
  `services/generation/build-plan.ts`'s `buildProductFactsContext` —
  the product's own real Shopify catalog facts, truncated to a short
  excerpt, never the full listing copy). Empty when a plan didn't
  populate these fields.
- `composeProviderPrompt(input)` — the grounding prefix + the
  already-fully-synthesized `creativeDirection.prompt` (built upstream
  by `build-plan.ts`/`plan-builder.ts` — category, scene, identity
  -preservation instruction, creative-override clause, etc. are ALL
  already baked in there; this module never re-derives any of that) +
  an explicit "Avoid: ..." clause for negative constraints, as ONE
  string — used by `OpenAIImageGenerationProvider`, whose contract has a
  single `prompt` field.
- The generic provider uses `composeProductGroundingPrefix` alone
  (prepended to `prompt`) and keeps `negative_prompt` as that contract's
  own separate field, rather than merging it into one string — see that
  file's request-body construction.

Everything upstream of this module — `services/generation/build-plan.ts`,
`services/creative-studio/plan-builder.ts`,
`services/creative-studio/identity-constraints.ts` — is where the actual
structured composition happens (product identity, identity anchors,
brand style, scene/environment/lighting/composition/camera direction,
creative overrides, negative constraints); `services/ai/` only ever
receives the ALREADY-STRUCTURED result and decides how to phrase it for
one specific vendor's wire format. See docs/creative-studio.md
"Identity preservation" / "Creative overrides" for that upstream
composition in full.

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

- **A specific commercial image-generation vendor (OpenAI, `gpt-image-1`)
  IS now selected and implemented** — see "Provider selection" above —
  but no live API key is configured in THIS development/CI environment,
  so generation here still runs through the deterministic test provider
  in practice; a real deployment (docs/production-deployment.md) needs
  a real `AI_PROVIDER_API_KEY` to actually call it. Intent parsing
  (`ProductionIntentParsingProvider`) still speaks a generic,
  self-defined contract, not a specific named vendor's real API —
  genuinely working against any endpoint that implements it, but not
  verified against one specific commercial LLM API the way the image
  provider now is. The generic `ProductionImageGenerationProvider`
  contract remains available for a self-hosted/other vendor with a
  materially different wire shape (needs its own adapter file behind
  the same interface, same pattern `openai-image-provider.server.ts`
  itself follows).
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
