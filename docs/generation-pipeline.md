# Generation pipeline

## Current state (Phase 0)

Not built. This document exists to record the intended shape so later
phases build toward a consistent design — none of the following exists in
code yet.

## Intended flow (future)

```
Merchant selects product(s) + source image(s) in the UI
  → services/generation: builds a generation request
      (shop, product, source image, operation, configuration)
  → enqueued onto the "generation" or "enhancement" queue (lib/queue)
  → workers/ picks up the job
      → services/ai: calls the configured AIProvider capability
          (removeBackground / enhanceImage / generateLifestyle /
           generateModelImage / analyzeProduct)
      → lib/storage: persists the result as a MediaAsset/MediaVersion
  → merchant reviews/approves in the UI
  → services/publishing: publishes approved assets back to Shopify
```

## Infrastructure that already exists for this

- `lib/queue/names.ts` reserves `"generation"`, `"enhancement"`, and
  `"publishing"` as queue names — no processor is registered on any of
  them yet (`workers/index.ts`'s `WORKER_REGISTRY` is empty).
- `services/ai/types.ts`'s `AIProvider` interface defines the capability
  surface a generation job will call into.
- `lib/storage/types.ts`'s `StorageProvider` interface defines where
  generation output will eventually be persisted.

## Explicitly not decided yet

- The shape of a generation request/job record (a `GenerationJob` model —
  see docs/database.md — is deliberately not created until the phase that
  needs it)
- Retry/failure semantics for generation jobs
- How generation cost maps to usage/credit accounting
- Aspect-ratio and batch-generation mechanics

Do not implement any of the above ahead of its phase — see CLAUDE.md
"Incremental development".
