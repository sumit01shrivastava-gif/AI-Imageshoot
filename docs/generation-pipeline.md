# Generation pipeline

## Current state (Phase 3; extended Phases 5–7)

The foundation described below is now implemented — see docs/generation.md
for the actual, current design (data model, provider abstraction, queue
lifecycle, identity preservation). Phase 5 (docs/lifestyle-generation.md)
built the first real creative capability on top of this foundation — AI
lifestyle product imagery (`GenerationType.LIFESTYLE`): category-aware
scene planning, brand style presets, batch generation, and review
(Approve/Reject). Phase 6 completed "Package 2" with
`GenerationType.MODEL_SHOOT` (model photography, gated on Product
Intelligence's `modelSuitable`) and merchant-selectable aspect ratio.
Phase 7 began "Package 3" with its product-scoped subset —
`GenerationType.BANNER`/`CTA`, a promotional banner or CTA image still
featuring one specific product. This document now only tracks what's
still ahead: the parts of the original sketch none of these phases
built.

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
    LIFESTYLE, (Phase 6) MODEL_SHOOT, and (Phase 7) BANNER/CTA results
    (Approve/Reject via `GenerationResult.reviewStatus` — see
    docs/lifestyle-generation.md "Review, regeneration, and generation
    history"); PRODUCT_CLEANUP results still show raw metadata only, no
    review state
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
- A real image-generation vendor (every generationType, including
  LIFESTYLE/MODEL_SHOOT/BANNER/CTA, still only runs through the
  deterministic test provider — see docs/lifestyle-generation.md
  "Provider strategy") and genuine semantic identity validation
  (`recordIdentityValidation` is an honest "not yet possible" result, not
  a real check — see docs/lifestyle-generation.md "Identity validation")
- Homepage/category-level banners and campaign generation THROUGH
  `GenerationJob` itself remain deferred — `GenerationType.CATEGORY_BANNER`/
  `CAMPAIGN` still reserve the taxonomy with no plan-building logic; only
  `PRODUCT_CLEANUP`, `LIFESTYLE`, `MODEL_SHOOT` (Phase 6), and the
  product-scoped `BANNER`/`CTA` (Phase 7) are driven end to end through
  `GenerationJob`. The not-product-scoped half of Package 3 — a homepage
  hero, a collection banner, a generic store CTA — IS now built, but as
  its own domain (`services/store-visuals/`, `StoreVisualJob`, see
  docs/store-visuals.md), not as a `GenerationJob` extension — the
  architectural decision this list used to describe as deferred has been
  made and implemented (a sibling model family, mirroring how Phase 4
  gave Processing its own family rather than reusing `GenerationJob`).
- Text/logo/typography rendering onto a generated image — every
  BANNER/CTA prompt explicitly instructs against it; a generated banner
  is a background photograph a merchant composites their own promotional
  copy onto elsewhere, not a finished asset with text baked in
- A source-image picker for generation, a free-text prompt editor, a full
  lifestyle scene-control panel beyond a brand style preset picker (see
  docs/lifestyle-generation.md "UI"), an output-count picker, a
  batch-level aspect ratio picker. Custom-preset-saving/editing/deleting
  IS now built (`/app/presets` — see docs/lifestyle-generation.md "Brand
  style presets").
- Real *upscale*/*shadow-generation*/*crop* infrastructure — the
  `ImageProcessingProvider` interface has these three methods, but only
  `removeBackground`/`enhance`/`resize` are implemented (Phase 4); see
  docs/image-processing.md "Supported operations"

Do not implement any of the above ahead of its phase — see CLAUDE.md
"Incremental development".
