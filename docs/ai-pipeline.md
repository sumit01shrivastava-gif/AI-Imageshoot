# AI pipeline

## Current state (Phase 0)

An abstraction only — `services/ai/types.ts` defines the `AIProvider`
interface and its capability input/output types. No vendor is selected,
no vendor SDK is installed, and no network call to any AI provider exists
anywhere in this codebase. `services/ai/unconfigured-provider.ts` provides
`UnconfiguredAIProvider`, which satisfies the interface and throws
`UnconfiguredAIProviderError` on every call — useful for type-checking
and unit-testing code that depends on `AIProvider` before a real
implementation exists.

## The interface

```ts
interface AIProvider {
  readonly name: string;
  analyzeProduct(input: AnalyzeProductInput): Promise<ProductAnalysis>;
  removeBackground(input: RemoveBackgroundInput): Promise<RemoveBackgroundResult>;
  enhanceImage(input: EnhanceImageInput): Promise<EnhanceImageResult>;
  generateLifestyle(input: GenerateLifestyleInput): Promise<GenerateLifestyleResult>;
  generateModelImage(input: GenerateModelImageInput): Promise<GenerateModelImageResult>;
}
```

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
