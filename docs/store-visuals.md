# Store Visuals — non-product-scoped generation (completion pass)

## Purpose

Phases 3–7 (`services/generation/`) generate imagery for exactly one
product: `GenerationJob.productId` is required and non-nullable, and
every `GenerationPlan` snapshots one product's identity anchors. But a
merchant's Shopify store also needs imagery that isn't about a single
product — a homepage hero, a collection banner, a generic store
call-to-action — sometimes featuring a product, sometimes not.

`services/store-visuals/` adds this as its own domain: `StoreVisualJob`/
`StoreVisualResult`, a `"store-visuals"` BullMQ queue, and dedicated
routes, reusing every piece of generation infrastructure that doesn't
assume "exactly one product" — the AI provider abstraction, storage,
review lifecycle, brand style presets — without forcing store-level
generation through `GenerationJob`'s product-required shape.

## Why a separate model family, not a nullable `GenerationJob.productId`

Two options were considered when this was scoped:

- **A. Make `GenerationJob.productId` nullable.** Rejected: `productId`
  is relied on throughout `services/generation/` (identity anchors,
  `sourceMediaIds`, the product-detail review UI, tenant-scoped history
  queries) as a required fact. Making it optional would ripple `null`
  checks through code that currently — correctly — assumes a product
  exists, for a use case (store-level assets) that is conceptually
  different enough to deserve its own shape.
- **B. A separate `StoreVisualJob`/`StoreVisualResult` model family.**
  Chosen. This is the same call Phase 4 made for `ProcessingJob` vs.
  `GenerationJob`: a genuinely different *kind* of request gets its own
  model, but reuses the underlying pattern (queue factory, storage,
  review lifecycle, provider resolution) rather than duplicating it.

Not chosen this pass: syncing Shopify collections first (there's no
existing collection sync — a real, separate feature) or a fully generic
subject/asset abstraction (speculative generality with no second use
case yet to validate the shape against).

## Data model

```
enum StoreVisualType { HOMEPAGE_HERO, COLLECTION_BANNER, STORE_CTA }
enum StoreVisualStatus { PENDING, QUEUED, PROCESSING, SUCCEEDED, FAILED, CANCELLED }

model StoreVisualJob {
  id, shop, type, status
  plan Json                 // StoreVisualPlanSchema, snapshotted at request time
  errorMessage, retryCount, providerName, providerJobId
  startedAt, completedAt, durationMs
  results  StoreVisualResult[]
  products StoreVisualJobProduct[]   // zero, one, or many — never required
}

model StoreVisualJobProduct {       // join row, mirrors ImageSelectionItem's pattern
  storeVisualJobId, productId, position
}

model StoreVisualResult {
  id, shop, storeVisualJobId
  storageKey, url, width, height, format
  providerName, providerResultId, metadata
  reviewStatus, reviewedAt
}

model ShopSettings {               // one row per shop, created lazily
  shop
  defaultBrandStylePresetId String?  // not a foreign key — see below
}
```

`StoreVisualJobProduct` is a join table (zero-to-many), not a scalar id
array — each reference stays independently queryable and cascades
cleanly if the underlying product is later removed by catalog sync,
mirroring `ImageSelectionItem`'s established pattern. A `StoreVisualJob`
with zero rows here is a fully generic store visual featuring no
specific product.

`ShopSettings.defaultBrandStylePresetId` is deliberately a plain string,
not a foreign key: it may reference either a built-in preset's
code-constant id (e.g. `"minimal-studio"`) or a shop-owned
`BrandStylePreset` row's cuid — both are resolved uniformly by
`resolveBrandStylePreset`. A stale default (pointing at a since-deleted
custom preset) degrades gracefully to "no preset" on read, rather than
needing to be kept in lockstep with deletes.

## `StoreVisualPlanSchema` — a sibling of `GenerationPlanSchema`, not a reuse

`GenerationPlanSchema.sourceProductId`/`sourceImages` are both mandatory
(`sourceImages.min(1)`), structurally incompatible with a zero-product
store visual. `services/store-visuals/schema.ts` defines its own
`StoreVisualPlanSchema`, but imports and reuses `GenerationPlanSchema`'s
actual building blocks directly: `SourceImageSchema`,
`BrandStyleContextSchema`, `AspectRatioSchema`, `OutputFormatSchema`,
`GenerationQualitySchema` (from `services/generation/schema.ts`) and
`IdentityAnchorsSchema` (from `services/intelligence/schema.ts`).

`services/ai/types.ts`'s `GenerateImageInput`/`ImageGenerationProvider`
needed **zero changes** — already fully generic (`productFacts:
Record<string, unknown>`, `sourceImages: ProductImageReference[]`, which
can be `[]`). The deterministic test provider never reads `sourceImages`
at all, so a zero-product plan produces a placeholder result exactly
like a product-scoped one.

## Best-effort identity preservation (no `ProductNotAnalyzedError`)

`services/generation/build-plan.ts` blocks single-product generation on
a `READY` Product Intelligence profile — the whole point is preserving
one product's exact appearance. `services/store-visuals/build-plan.ts`
never blocks on analysis: identity anchors are captured as `null` per
product reference when a referenced product hasn't been analyzed (or has
no analysis at all). Reasoning: a store visual isn't primarily about one
product's exact appearance the way single-product generation is — this
mirrors Phase 4's identical "processing is never blocked on analysis"
precedent for the same underlying reason (a deterministic/store-level
operation doesn't need creative-identity grounding the way single-product
generation does).

`services/store-visuals/job.server.ts`'s `recordStoreVisualIdentityValidation(plan)`
extends the single-product `recordIdentityValidation` boundary (Phase 5)
to the 0..N-product case: it maps the boundary function over every
referenced product that has identity anchors, returning
`{validated: false, reason, products: [{productId, identityAnchorsChecked}]}`
— an honest, structured "not yet possible" result (see
docs/lifestyle-generation.md "Identity validation" for what "honest"
means here), never a fabricated pass. The `reason` string distinguishes
"no products referenced" from "no vision-capable provider configured
and no referenced product has identity anchors available."

## Provider, storage, queue reuse

Every piece of generation infrastructure that doesn't assume "exactly
one product" is reused directly, unmodified:

- `getConfiguredImageGenerationProvider` (`services/generation/provider.server.ts`)
  — same resolver, same double-gated deterministic test provider, same
  `UnconfiguredImageGenerationProvider` fallback. No real vendor
  selected — see docs/generation-pipeline.md.
- `getConfiguredStorageProvider`/`resignResultUrls` (`lib/storage/`) —
  same signed-URL persistence and fresh-resigning-on-read pattern (see
  "Signed URL freshness" below).
- The `"store-visuals"` BullMQ queue is a NEW queue name (`lib/queue/names.ts`),
  but constructed through the exact same `createQueue`/`createWorker`
  factory (`lib/queue/queue.server.ts`) with the same `attempts: 3` +
  exponential-backoff retry semantics as `"generation"`/`"enhancement"`.
- `getBuiltInPreset`/`resolveBrandStylePreset` (`services/generation/brand-style-preset.server.ts`)
  — the same brand style presets LIFESTYLE/MODEL_SHOOT/BANNER/CTA use.

## Signed URL freshness

A stored `GenerationResult`/`ProcessingResult`/`StoreVisualResult.url` is
signed ONCE, at creation time, for one hour (see each domain's
`job.server.ts`'s `persistOutput`). Any read path returning that stored
URL as-is shows a broken image for a result older than an hour — a real
bug that predates this pass and affected every history/review page.
`lib/storage/resign.server.ts`'s `resignResultUrls` re-signs fresh from
the never-expiring `storageKey` at read time; every read-side service
function across all three domains (`getGeneration`/`listGenerationHistory`/
`getGenerationBatchSummary`, `getProcessing`/`listProcessingHistory`/
`getBatchSummary`, `getStoreVisual`/`listStoreVisualHistory`) and
`services/assets/asset-library.server.ts` now go through it. See
`tests/integration/generation/generation-url-resign.test.ts` for the
regression test that proves an intentionally-expired stored URL is
replaced with a currently-valid one.

The same file's `withResultsSanitizedForClient` strips `storageKey`
(needed server-side to resign, never meant for the client) from every
result before a loader returns it to `useLoaderData` — closing a related
internal-path-exposure gap across the same four read paths. See
`tests/unit/storage/sanitize.test.ts` and
`tests/integration/routes/app.products.id-loader.test.ts`'s "no internal
storage path leakage" test.

## UI

- `app/routes/app.store-visuals._index.tsx` — create-only form: visual
  type, brand style preset, aspect ratio, an optional product picker
  (search + paginated table + local multi-select), never a free-text
  prompt. Submitting redirects to the new job's detail page.

  **Filename note**: this is `app.store-visuals._index.tsx`, not
  `app.store-visuals.tsx` — under `@react-router/fs-routes`' flat-file
  convention, a file named `app.store-visuals.tsx` automatically becomes
  the PARENT LAYOUT route for `app.store-visuals.$jobId.tsx` (same
  convention that makes `app.products.tsx` — a real `<Outlet/>` layout —
  necessary alongside `app.products._index.tsx`). A page-shaped
  component with no `<Outlet/>` at that path silently breaks every child
  route: the URL updates on navigation, but the child's content never
  renders, because the router keeps rendering the "parent's" own JSX.
  This was a real, initially-shipped bug in this pass — caught by an E2E
  test, not by a schema/type error, since it's a naming-convention issue,
  not a compile-time one — fixed by the `_index` rename. Any future
  `app.store-visuals.*` route MUST NOT be named bare `app.store-visuals.tsx`.
- `app/routes/app.store-visuals.$jobId.tsx` — single-job progress/review,
  a structural mirror of `app.generation.$batchId.tsx` (status, featured
  products, result image, Approve/Reject/Regenerate) — one job, not a
  batch, since store visuals aren't created in batches this phase.
  Regenerate does NOT redirect server-side (unlike create) — it returns
  `{ok: true, jobId}` from the fetcher action and the client calls
  `useNavigate()` explicitly, because regenerate creates a job at a NEW
  url (unlike product-imagery's in-place regenerate).
- Nav: `/app/store-visuals` and `/app/assets` links added to
  `app/routes/app.tsx`'s `<s-app-nav>`.

## Review, regeneration, history

Same shape as every other domain: Approve/Reject never mutates or
deletes a result; Regenerate always creates a brand-new
`StoreVisualJob`/`StoreVisualResult`, never overwrites. A batch's/job's
own regenerate preserves the original job's `visualType`/`productIds`/
`aspectRatio` (read back off the persisted plan), the same
"regenerate-preserves-configuration" fix Phase 6 applied to
generation batches.

Shop-wide, paginated history (`listStoreVisualHistory` /
`listStoreVisualJobsForShop`) is the first SHOP-WIDE (not per-product)
paginated job listing in the codebase — store visuals have no single
owning product to scope history by. It's the direct precedent
`services/assets/asset-library.server.ts` (docs/asset-library.md)
builds on for its own shop-wide, cross-domain listing.

## Security / tenant isolation

Every entry point takes `AuthContext` and re-verifies shop ownership —
the same convention as every other domain:

- `ProductNotFoundError` (in `services/store-visuals/request-store-visual.server.ts`)
  is its OWN class, not imported from `services/generation/`, so each
  domain's error stays independently catchable at its own route
  boundary — but follows the identical safe-404 pattern (a cross-shop
  product id resolves the same as a nonexistent one, never distinguishing
  the two).
- `StoreVisualJob`/`StoreVisualResult` reads go through
  `assertShopOwnership`, mapped to the same safe 404 every other
  not-found case in this app uses.
- A cross-shop `resultId` in a review action fails the same way every
  other domain's review action fails (checked equality, no
  distinguishable error).

## Testing

- **Unit**: `tests/unit/store-visuals/types.test.ts`,
  `tests/unit/store-visuals/build-plan.test.ts` (zero-product plans,
  per-type aspect ratio defaults, override precedence, never-throws-on-
  unanalyzed, multi-product prompts, preset application).
- **Integration**: `tests/integration/store-visuals/store-visual-queue.test.ts`
  (real BullMQ worker — zero-product success, multi-product success with
  identity capture, cross-shop `ProductNotFoundError`, approve/regenerate
  independence), `tests/integration/store-visuals/store-visual-job.repository.test.ts`
  (pagination, filters, tenant isolation), `tests/integration/routes/app.store-visuals-action.test.ts`
  (route-level create/review/regenerate).
- **E2E**: `tests/e2e/store-visuals.spec.ts` — create a homepage hero
  with no product → queued/processing → succeeded → Approve → Regenerate
  → the previous approved result remains; plus the AI Assets library
  scenarios (see docs/asset-library.md "Testing").

## Explicitly deferred

- `HOMEPAGE_HERO`/`COLLECTION_BANNER`/`STORE_CTA` are the only three
  store visual types (mirroring the Package 3 scoping decision's
  original list). No campaign/multi-asset generation.
- No collection sync — `COLLECTION_BANNER` doesn't reference a specific
  Shopify collection object (there's nothing to reference yet); it's a
  generic collection-style banner, styled by preset/creative direction
  only.
- No real image-generation vendor — same as every other generation
  domain in this codebase, store visuals run only through the
  deterministic test provider.
- No batch store-visual creation (batches remain product-scoped, built
  on Phase 1's `ImageSelection`, which doesn't fit "zero-to-many
  products" naturally).
