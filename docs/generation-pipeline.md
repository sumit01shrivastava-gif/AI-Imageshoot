# Generation pipeline

## Current state (Phase 3)

The foundation described below is now implemented — see docs/generation.md
for the actual, current design (data model, provider abstraction, queue
lifecycle, identity preservation). This document now only tracks what's
still ahead: the parts of the original sketch Phase 3 deliberately did
NOT build.

```
Merchant selects a product (Phase 3: always every one of its own images —
no picker yet) in the UI
  → services/generation: builds a structured GenerationPlan
      (shop, product, source images, Product Intelligence identity
       anchors, generation type, creative direction)
  → enqueued onto the "generation" queue (lib/queue) — IMPLEMENTED
      → workers/ picks up the job — IMPLEMENTED
          → services/ai: calls the configured ImageGenerationProvider
            (generateImage) — IMPLEMENTED, no real vendor selected
          → lib/storage: persists the result via StorageProvider,
            referenced by a GenerationResult row — IMPLEMENTED, no real
            storage vendor selected
  → merchant reviews/approves in the UI — NOT BUILT (Phase 3's UI shows
    the raw result only; no approval workflow)
  → services/publishing: publishes approved assets back to Shopify —
    NOT BUILT
```

`removeBackground`/`enhanceImage` are no longer `AIProvider` methods —
Phase 3 split them out into a separate `ImageProcessingProvider`
interface (established as an abstraction only that phase). **Phase 4
implemented it** — `removeBackground` (a real vendor, remove.bg),
`enhance`/`resize` (local, via `sharp`) — and registered the
`"enhancement"` queue. This is a *different* pipeline from the one
diagrammed above (deterministic transforms of an *existing* image, not
creative generation) — see docs/image-processing.md for its own full
data flow, not a variant of this one.

## Explicitly not decided/built yet

- A `MediaAsset`/`MediaVersion` promoted-asset layer distinct from
  `GenerationResult` (see docs/database.md) — this phase's terminal
  artifact is a `GenerationResult`; "promoting" one into a durable,
  merchant-approved asset is future work
- Review/approval workflow (`GenerationStatus` has no approval-related
  state; "SUCCEEDED" is not "approved")
- Publishing approved assets back to Shopify (`services/publishing/`)
- How generation cost maps to usage/credit accounting (Phase 3 records
  the structured metadata a future phase would need — provider, duration,
  output count — but computes no cost)
- A source-image picker for generation, a prompt editor, a model/pose
  selector, campaign generation (batch *processing* — a different
  pipeline — exists; see docs/image-processing.md)
- Real *upscale*/*shadow-generation*/*crop* infrastructure — the
  `ImageProcessingProvider` interface has these three methods, but only
  `removeBackground`/`enhance`/`resize` are implemented (Phase 4); see
  docs/image-processing.md "Supported operations"

Do not implement any of the above ahead of its phase — see CLAUDE.md
"Incremental development".
