# AI pipeline

## Current state (Phase 3)

`services/ai/types.ts` defines three separate, focused provider
interfaces — no vendor is selected, no vendor SDK is installed, and no
network call to any AI provider exists anywhere in this codebase.
`services/ai/unconfigured-provider.ts` provides an `Unconfigured*`
implementation of each, which satisfies its interface and throws
`UnconfiguredAIProviderError` on every call — the default everywhere
outside of tests, since no real vendor exists yet.

- **`AIProvider`** — product analysis (`analyzeProduct`). Called by Phase
  2 (Product Intelligence) — see docs/product-intelligence.md.
- **`ImageGenerationProvider`** — generative image creation
  (`generateImage`). Called by Phase 3 (image generation foundation) —
  see docs/generation.md.
- **`ImageProcessingProvider`** — deterministic/transformative operations
  on an existing image (`removeBackground`, `enhance`, `upscale`,
  `generateShadow`, `crop`, `resize`). Established this phase as an
  interface + `Unconfigured` implementation only — nothing calls it yet;
  see docs/generation.md "Processing abstraction".

These are three interfaces, not one do-everything `AIProvider`, because
each is a genuinely different capability with a different input/output
shape and may end up backed by different vendors — see docs/generation.md
for why an earlier, single-interface draft (with `removeBackground`/
`enhanceImage`/`generateLifestyle`/`generateModelImage` all on one
`AIProvider`) was replaced.

Each of Phase 2 and Phase 3 is the first caller of its own interface, and
each exercises the whole interface-first design (business logic depending
on the interface, not a vendor) in tests via a deterministic, network-free
test provider owned by that domain (`services/intelligence/`,
`services/generation/`). Neither selects or installs a real vendor.

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

`analyzeProduct` and `generateImage` are the two capabilities actually
called (by Phase 2 and Phase 3 respectively) — see
docs/product-intelligence.md and docs/generation.md for their input
shapes and why each output type is deliberately loose/untyped where a
real vendor's response can't be trusted structurally (validated
separately by a Zod schema, never trusted as-is). `ImageProcessingProvider`
remains entirely unimplemented and uncalled.

Each capability is a separate method (rather than one generic
"generate(prompt)" call) because each has a distinct, typed input/output
shape and may end up backed by different vendors or models.
`ImageGenerationProvider.generateImage` and `ImageProcessingProvider`'s
methods return raw image bytes (`Uint8Array`) plus content type — a
temporary, provider-owned artifact, never assumed to live anywhere in
particular; the caller persists it through `lib/storage/`'s
`StorageProvider` abstraction (see docs/generation.md "Storage").

## Rules for the eventual real provider(s)

- Lives in `services/ai/`, implements one of the interfaces above. No
  other module may import the vendor's SDK directly.
- Reads credentials only via `lib/validation/env.server.ts`
  (`AI_PROVIDER`, `AI_PROVIDER_API_KEY`, `AI_PROVIDER_BASE_URL`) — never
  hardcoded, never logged (these keys are in `SECRET_ENV_KEYS`).
- Never called from an automated test with real credentials or a real
  network request.

## Not yet designed (future phases)

- Which vendor(s) to integrate, for generation or for processing
- An `ImageProcessingProvider` implementation (real or test) and its
  resolver/queue/route wiring — none exist yet, only the interface
- Prompt/config construction beyond `PRODUCT_CLEANUP` (see
  docs/generation.md "Generation types" for which of the nine taxonomy
  values have dedicated plan-building logic today)
- Batch generation, additional aspect ratios, generation presets
- Cost/usage accounting per call (ties into the future `UsageRecord`
  model — see docs/database.md); Phase 3 records the structured metadata
  (provider, duration, output count, ...) a future phase would need, but
  computes no cost itself
- Validating a generated result against its identity anchors — Phase 3
  propagates `identityAnchors` all the way to the provider input
  specifically so a future phase can do this; nothing inspects generated
  output content yet
