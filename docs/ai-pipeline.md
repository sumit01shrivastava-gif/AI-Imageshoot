# AI pipeline

## Current state (Phase 2)

`services/ai/types.ts` defines the `AIProvider` interface and its
capability input/output types. No vendor is selected, no vendor SDK is
installed, and no network call to any AI provider exists anywhere in this
codebase. `services/ai/unconfigured-provider.ts` provides
`UnconfiguredAIProvider`, which satisfies the interface and throws
`UnconfiguredAIProviderError` on every call — the default everywhere
outside of tests, since no real vendor exists yet.

Phase 2 (Product Intelligence, docs/product-intelligence.md) is the first
caller of this interface — it calls `analyzeProduct` through
`services/intelligence/provider.server.ts`'s `getConfiguredAIProvider()`,
and exercises the whole interface-first design (business logic depending
on `AIProvider`, not a vendor) in tests via a deterministic, network-free
test provider. It does not select or install a real vendor.

## The interface

```ts
interface AIProvider {
  readonly name: string;
  analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysisRawOutput>;
  removeBackground(input: RemoveBackgroundInput): Promise<RemoveBackgroundResult>;
  enhanceImage(input: EnhanceImageInput): Promise<EnhanceImageResult>;
  generateLifestyle(input: GenerateLifestyleInput): Promise<GenerateLifestyleResult>;
  generateModelImage(input: GenerateModelImageInput): Promise<GenerateModelImageResult>;
}
```

`analyzeProduct` is the one capability actually called as of Phase 2
(Product Intelligence) — see docs/product-intelligence.md for its input
shape (`AnalyzeProductInput`, built from synced catalog data, not a live
Shopify call), why its output (`ProductAnalysisRawOutput`) is deliberately
untyped JSON validated separately by a Zod schema, and the
`services/intelligence/`-owned test provider used in tests. The other
four capabilities remain unimplemented abstractions until the phases that
need them.

Each capability is a separate method (rather than one generic
"generate(prompt)" call) because each has a distinct, typed input/output
shape and may end up backed by different vendors or models. Every image
input/output is an `ImageRef` — a storage key + content type, never a raw
URL — so the interface doesn't assume where an image physically lives
(see docs/architecture.md's `lib/storage/` boundary).

## Rules for the eventual real provider(s)

- Lives in `services/ai/`, implements `AIProvider`. No other module may
  import the vendor's SDK directly.
- Reads credentials only via `lib/validation/env.server.ts`
  (`AI_PROVIDER`, `AI_PROVIDER_API_KEY`, `AI_PROVIDER_BASE_URL`) — never
  hardcoded, never logged (these keys are in `SECRET_ENV_KEYS`).
- Never called from an automated test with real credentials or a real
  network request.

## Not yet designed (future phases)

- Which vendor(s) to integrate
- Prompt/config construction for lifestyle vs. AI-model generation
- Batch generation, aspect-ratio handling, generation presets
- Cost/usage accounting per call (ties into the future `UsageRecord`
  model — see docs/database.md)
- Queue wiring: generation is expected to run through the `"generation"`
  and `"enhancement"` queues (`lib/queue/names.ts`), not inline in a
  request/response cycle, but no processor exists yet
