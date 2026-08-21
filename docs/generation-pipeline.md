# Generation pipeline

## Current state (Phase 3; extended Phase 5)

The foundation described below is now implemented — see docs/generation.md
for the actual, current design (data model, provider abstraction, queue
lifecycle, identity preservation). Phase 5 (docs/lifestyle-generation.md)
built the first real creative capability on top of this foundation — AI
lifestyle product imagery (`GenerationType.LIFESTYLE`): category-aware
scene planning, brand style presets, batch generation, and review
(Approve/Reject). This document now only tracks what's still ahead: the
parts of the original sketch neither phase built.

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
  → merchant reviews/approves in the UI — IMPLEMENTED as of Phase 5, for
    LIFESTYLE results only (Approve/Reject via `GenerationResult.reviewStatus`
    — see docs/lifestyle-generation.md "Review, regeneration, and
    generation history"); PRODUCT_CLEANUP results still show raw metadata
    only, no review state
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
  `GenerationResult` (see docs/database.md) — a generation's terminal
  artifact is still a `GenerationResult`; "promoting" one into a durable,
  merchant-approved asset is future work
- Publishing approved assets back to Shopify (`services/publishing/`)
- How generation cost maps to usage/credit accounting (structured
  metadata a future phase would need — provider, duration, output count
  — is recorded, but no cost is computed and no plan/credit is enforced)
- A real image-generation vendor (LIFESTYLE, like PRODUCT_CLEANUP, still
  only runs through the deterministic test provider — see
  docs/lifestyle-generation.md "Provider strategy") and genuine semantic
  identity validation (Phase 5's `recordIdentityValidation` is an honest
  "not yet possible" result, not a real check — see
  docs/lifestyle-generation.md "Identity validation")
- AI human models/model shoots/pose selection, website/category banners,
  CTA imagery, campaign generation — `GenerationType` reserves the
  taxonomy (`MODEL_SHOOT`, `BANNER`, `CATEGORY_BANNER`, `CTA`,
  `CAMPAIGN`) but none has dedicated plan-building logic yet; only
  `PRODUCT_CLEANUP` and `LIFESTYLE` are driven end to end
- A source-image picker for generation, a free-text prompt editor, a full
  lifestyle scene-control panel beyond a brand style preset picker (see
  docs/lifestyle-generation.md "UI"), custom-preset-saving UI (the
  `BrandStylePreset` model/service are fully built; no UI action exists
  to create one yet)
- Real *upscale*/*shadow-generation*/*crop* infrastructure — the
  `ImageProcessingProvider` interface has these three methods, but only
  `removeBackground`/`enhance`/`resize` are implemented (Phase 4); see
  docs/image-processing.md "Supported operations"

Do not implement any of the above ahead of its phase — see CLAUDE.md
"Incremental development".
