# Product Intelligence (Phase 2)

## Purpose

Before any image is generated, the app needs to understand the product it
is generating images *for*: what it is, what it's made of, who it's for,
what kind of imagery suits it, and — critically — what about it must never
change. Product Intelligence is that understanding, captured as a
structured, validated, versioned profile per product.

This phase builds **only** the intelligence layer. No image generation,
no vendor integration, no background removal/editing, no publishing, no
billing exists here or is implied by anything in this document — see
CLAUDE.md "Incremental development" and "What's deliberately not built
yet" below.

## Data flow

```
Merchant clicks "Analyze Product" (app/routes/app.products.$id.tsx)
  → action: requestProductAnalysis(context, productId)
      (services/intelligence/product-intelligence.server.ts)
      → findProductForShop — re-verifies shop ownership server-side,
        never trusts the browser-supplied product id
      → ensurePendingAnalysis — upserts a PENDING row (idempotent)
      → enqueueProductIntelligenceAnalysis — real BullMQ enqueue
        (services/intelligence/queue.server.ts, lib/queue/)
  ← action returns immediately; UI shows "Analyzing" and polls

workers/index.ts's "product-intelligence" worker
  → processProductIntelligenceJob (services/intelligence/job.server.ts)
      → markProcessing
      → buildAnalyzeProductInput(product) — maps our synced Shopify
        catalog data to AnalyzeProductInput (services/intelligence/
        build-input.ts)
      → getConfiguredAIProvider().analyzeProduct(input)
          (services/ai/types.ts's AIProvider — vendor-agnostic)
      → parseProductIntelligenceOutput(raw) — Zod validation, throws on
        anything malformed (services/intelligence/schema.ts)
      → saveResult — persists as the product's current profile,
        bumps analysisVersion (db/repositories/
        product-intelligence.repository.ts)
      → on any failure: markFailed with a merchant-safe message

Merchant's product detail page (loader)
  → getProductIntelligence + getIntelligenceDisplayState
  ← renders category/material/color/style/use cases/model suitability/
    recommended asset types, or the appropriate not-analyzed/analyzing/
    failed/stale state
```

Nothing here runs automatically. Catalog sync (Phase 1) never triggers
analysis, install never triggers analysis, and there is no bulk/batch
analysis — every analysis is one explicit merchant action per product
(see "Performance" below).

## Data sources

`buildAnalyzeProductInput` (services/intelligence/build-input.ts) builds
`AnalyzeProductInput` purely from data already synced into our own
`ShopifyProduct`/`ShopifyProductMedia` tables (Phase 1) — title,
description, product type, category, vendor, tags, and media (id, CDN
URL, alt text, position). No live Shopify API call happens during
analysis; the synced catalog is the input.

Images are passed as `ProductImageReference { mediaId, url, altText,
position }` — a Shopify-hosted CDN URL reference, never raw image bytes
routed through the browser or held in server memory as a blob. A future
real provider implementation decides for itself how to fetch/forward that
URL to the vendor (see CLAUDE.md "Storage rules" — Shopify-hosted media is
never treated as our own permanent storage).

An optional `brandStyle: BrandStyleContext` (visualTone, colorPalette,
photographyStyle, backgroundStyle, lightingStyle, compositionStyle,
luxuryLevel, modelStyle) can be passed through today, but nothing
constructs one yet — see "Brand style foundation" below.

## Provider abstraction

`AIProvider.analyzeProduct(input: AnalyzeProductInput):
Promise<ProductAnalysisRawOutput>` (services/ai/types.ts) is the one
`AIProvider` capability this phase actually calls. It returns loosely
typed, untrusted JSON (`ProductAnalysisRawOutput = Record<string,
unknown>`) — the provider is not trusted to have returned anything
well-formed; `services/intelligence/schema.ts` is the sole gate before
persistence.

No AI vendor SDK is installed. `getConfiguredAIProvider()`
(services/intelligence/provider.server.ts) resolves to
`UnconfiguredAIProvider` (throws `UnconfiguredAIProviderError` on every
call) everywhere except a narrow, double-gated test seam:
`DeterministicTestAIProvider` (services/intelligence/
deterministic-test-provider.server.ts) is only selected when **both**
`NODE_ENV === "test"` and `AI_PROVIDER === "deterministic-test"` — the
same double-gate pattern `services/shopify/admin-context.server.ts` uses
for its E2E auth bypass, so this can never activate in development or
production by accident.

When a real vendor (OpenAI/Anthropic/Gemini/...) is added, it implements
`AIProvider` and lives in `services/ai/`; `getConfiguredAIProvider` is the
only place that needs to change to wire it in. Everything in
`services/intelligence/` — the job processor, the service entry point,
the UI — depends only on the `AIProvider` interface, never a vendor SDK.

`DeterministicTestAIProvider` itself lives in `services/intelligence/`,
not `services/ai/`, because it has Product-Intelligence-domain knowledge
(it uses `category-recommendations.ts` to produce realistic canned
output) — `services/ai/` stays vendor- *and* domain-generic per CLAUDE.md's
"AI providers are isolated" boundary.

## Schema (`services/intelligence/schema.ts`)

`ProductIntelligenceSchema` (Zod) is the single validation gate every
provider's raw output passes through via `parseProductIntelligenceOutput`
— malformed output throws `InvalidProductIntelligenceOutputError` (with a
field-by-field `issues` list) and is never persisted or coerced into
something plausible-looking. Not `.strict()`: an unrecognized extra field
from a provider doesn't fail validation, but every field we persist is
validated (type, enum membership, nullability).

Covers: `category`/`subcategory`/`productType`, `material`/`primaryColor`/
`secondaryColors`, `pattern`/`texture`/`style`, `useCases`/
`targetAudience`/`genderSuitability` (enum: men/women/unisex/kids/
not_applicable)/`seasonality`/`pricePositioning` (enum: budget/mid_range/
premium/luxury), free-form JSON `visualCharacteristics`/
`productDimensions`/`packagingCharacteristics` plus `hardwareComponents`,
`modelSuitable`/`recommendedModelAttributes`/`recommendedPoseTypes`,
`recommendedEnvironments`/`recommendedProps`/
`recommendedPhotographyStyles`/`recommendedAssetTypes` (enum array, at
least one required), `identityAnchors` (mandatory, see below),
`imageAnalyses` (see below), and a nullable provider-reported
`confidence` (0–1).

## Identity preservation

`identityAnchors` (`IdentityAnchorsSchema`) is a mandatory section on
every READY profile — `category`, `shape`, `material`, `primaryColor`,
`constructionDetails`, `distinctiveHardware`, `brandingVisible`/
`brandingDescription`. These are the attributes a future generation stage
must treat as constraints, not suggestions: a red leather handbag's
analysis must never imply "blue handbag", "plastic handbag", or a
different shape/silhouette unless the source product data or images
genuinely support that. This phase does not build any generation-time
validation against these anchors — that's future work — but the
structure exists now so a later phase has something concrete to constrain
against, rather than free-text description alone.

## Image analysis

`imageAnalyses` (`ImageAnalysisSchema[]`) carries one entry per analyzed
source image: `mediaId` (correlates back to `ShopifyProductMedia`), `url`,
`relevance` (primary/secondary/detail/packaging/irrelevant),
`qualityIndicators` (sharpness/lighting: low/medium/high;
backgroundClarity: cluttered/plain/studio — all nullable), and free-text
`identityObservations`. This phase does not perform expensive image
processing (no pixel-level analysis, no CV pipeline) — it's the shape a
provider's own (future, possibly multimodal) analysis reports into, kept
as JSON on the `ProductIntelligence` row rather than a separate table
since it's always read/written as part of the whole profile, never
queried independently.

## Generation recommendations

`services/intelligence/category-recommendations.ts` is a data-driven
lookup table (`CATEGORY_PROFILES`), not per-category conditionals — adding
a category is adding one table row. Each profile maps a set of matched
keywords (case-insensitive substring match against category/product
type/title, first match wins) to `recommendedAssetTypes`, `modelSuitable`,
`recommendedEnvironments`, and `recommendedPoseTypes`. Covers jewelry,
eyewear, handbags, shoes, clothing (all `modelSuitable: true`) and
furniture, appliances, electronics, food (all `modelSuitable: false`),
with a safe default for anything unmatched. This table is reference
grounding for the deterministic test provider and a future real
provider's prompt construction — it is never force-applied over a
provider's own validated output; the schema already requires every
provider to supply its own `recommendedAssetTypes`/`modelSuitable`.

`ASSET_TYPES` (the six recognized asset shapes): `product_studio`,
`lifestyle`, `model_shoot`, `detail`, `packaging`, `scene`.

## Model suitability

`modelSuitable`/`recommendedModelAttributes`/`recommendedPoseTypes`/
`recommendedEnvironments` are structured intelligence fields, not UI-only
logic — e.g. jewelry/clothing/shoes/eyewear/handbags are model-suitable;
furniture/appliances/food are not; electronics fall to the safe default
(not model-suitable). **No AI-model image is generated anywhere in this
phase or by anything in this codebase** — this only records whether human
-model imagery would make sense for the product, for a future generation
phase to act on.

## Brand style foundation

`AnalyzeProductInput.brandStyle?: BrandStyleContext` (services/ai/
types.ts) — `visualTone`, `colorPalette`, `photographyStyle`,
`backgroundStyle`, `lightingStyle`, `compositionStyle`, `luxuryLevel`,
`modelStyle` — exists on the interface so a future "Brand Style" feature
doesn't require an `AIProvider` interface change to start passing one.
Nothing constructs or persists a `BrandStyleContext` yet; every call site
today passes `undefined`.

## Lifecycle and status

`IntelligenceStatus` (`prisma/schema.prisma`): `PENDING → PROCESSING →
READY`, or `→ FAILED` on error. One row per product
(`ProductIntelligence.productId @unique`) — re-analysis overwrites the
current profile in place rather than creating a new row; a full analysis
history table is deliberately deferred (not needed to prove the
intelligence layer works).

`analysisVersion` (`Int @default(0)`) is bumped only by `saveResult` —
`ensurePendingAnalysis`/`markProcessing` never touch it — so it always
reflects "how many analyses have actually completed", regardless of how
many PENDING/PROCESSING bookkeeping upserts ran on the way there.

## Staleness

There is **no persisted `STALE` status** — see the enum's comment in
`prisma/schema.prisma`. A `READY` profile is considered stale purely at
read time (`services/intelligence/stale.ts`'s `isIntelligenceStale`):
when the product's own `ShopifyProduct.shopifyUpdatedAt` (Shopify's
timestamp, only bumped when a merchant actually edits the product) has
moved past `ProductIntelligence.sourceShopifyUpdatedAt` (the watermark
recorded at analysis time). Deliberately **not** based on our local
`ShopifyProduct.updatedAt`/`syncedAt`, which changes on every catalog
resync regardless of whether anything intelligence-relevant changed —
that would mark nearly every profile stale immediately and make the
signal useless. This reuses Phase 1's existing sync data rather than
introducing new webhook plumbing.

`getIntelligenceDisplayState` combines the persisted `status` with this
derived check into the five states the UI renders: `not_analyzed`
(no row, or `PENDING`), `analyzing` (`PROCESSING`), `ready` (`READY`,
not stale), `stale` (`READY`, stale), `failed` (`FAILED`).

## Queue behavior

The `"product-intelligence"` BullMQ queue (`lib/queue/names.ts`) goes
through the same shared `lib/queue/` factory (`createQueue`/
`createWorker`) as every other queue — no new queue abstraction. Job ids
are built with `lib/queue/job-id.ts`'s `buildJobId("product-intelligence",
shop, productId)`, the same sha256-hashed, `:`-safe, deterministic-per-
product scheme the Phase 1 catalog sync queue uses (generalized out of
`services/products/sync-job.server.ts` into shared `lib/queue/` for this
phase). Combined with the shared factory's `removeOnComplete`/
`removeOnFail: true` defaults, a finished job's id is reusable — so
re-analyzing an already-`READY` product always gets a real, running job,
never a silent no-op against a job id BullMQ still considers "in flight"
or "already done". This is the same class of bug the Phase 0/1 security
audit found and fixed in the catalog sync queue; Product Intelligence
reuses the fix rather than repeating the bug.

`processProductIntelligenceJob` (services/intelligence/job.server.ts) is
idempotent — re-running it for the same product simply re-analyzes and
overwrites the current profile — and shop-scoped: even though its payload
is server-derived (only ever enqueued from `requestProductAnalysis`,
itself gated on a verified `AuthContext`), it still calls
`findProductForShop` with a worker-constructed `AuthContext`, as defense
in depth rather than trusting the payload blindly. On any failure
(unconfigured provider, invalid provider output, or anything else) it
calls `markFailed` with one of three fixed, merchant-safe messages —
never a raw error/stack trace — then rethrows so BullMQ's retry/backoff
still applies.

## UI

`app/routes/app.products.$id.tsx`'s "Product Intelligence" section shows
a status badge (`not_analyzed`/`analyzing`/`ready`/`stale`/`failed`), an
"Analyze Product" (or "Re-analyze Product" once a `READY`/`stale` profile
exists) button, a stale banner prompting re-analysis, a failure banner
with the merchant-safe error message, and — once `ready`/`stale` — the
structured fields (category, subcategory, material, color, style, use
cases, target audience/gender suitability/seasonality/price positioning,
model suitability, recommended asset types, recommended environments/
photography styles). No image-generation UI exists anywhere on this page.

The action (`intent=analyze`) calls `requestProductAnalysis` and returns
a generic, safe error on any failure — a cross-shop product id resolves
to the same 404 as a genuinely nonexistent one (never an existence
oracle). The client polls the loader every 3s while a requested analysis
hasn't yet reached a terminal state, so the badge/fields update once the
worker finishes without a manual page refresh.

## Security

- Every route entry point calls `requireAdminContext(request)` first (see
  CLAUDE.md); `requestProductAnalysis`/`getProductIntelligence` both take
  the resulting `AuthContext` and re-verify shop ownership of the
  client-supplied product id via `findProductForShop`/`getForProduct` —
  a client-supplied id is never trusted directly.
- A `TenantMismatchError` (product exists, but belongs to another shop)
  is converted to the same `ProductNotFoundError`/404 as a genuinely
  missing product — never distinguishable, never an existence oracle.
- `rawAnalysis` (unvalidated provider output, kept for debugging) is
  excluded from every merchant-facing select (`SAFE_SELECT` in
  `db/repositories/product-intelligence.repository.ts`).
- No AI provider secret is ever read outside `lib/validation/env.server.ts`
  or exposed to a loader's returned data/client bundle.
- Failures are logged in full (redacted) server-side via `logger`; the
  merchant only ever sees one of the three fixed, generic messages in
  `job.server.ts`.

## Performance

No automatic or bulk analysis. Catalog sync (Phase 1) never triggers
analysis and remains fully independent of it — no AI call happens during
sync, ever. Every analysis is one explicit "Analyze Product"/"Re-analyze
Product" click per product. Batch/bulk analysis is explicitly deferred to
a future phase.

## Relationship to future image generation (not built here)

Product Intelligence is designed to be what a future generation phase
reads from — `identityAnchors` as hard constraints, `recommendedAssetTypes`
/`recommendedEnvironments`/`recommendedPhotographyStyles` as generation
strategy input, `modelSuitable`/`recommendedModelAttributes`/
`recommendedPoseTypes` as whether/how to involve an AI model. **None of
that consumption exists yet.** This phase implements the intelligence
layer only: no image generation, no AI-model generation, no lifestyle
generation, no background removal/enhancement/upscaling, no publishing,
no billing/credits — see CLAUDE.md "Incremental development".
