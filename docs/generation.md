# Image Generation Foundation (Phase 3)

## Purpose

Phase 2 (docs/product-intelligence.md) built the layer that understands a
product. Phase 3 builds the layer that turns that understanding into an
image-generation *request* — the plumbing between "we know what this
product is" and "an AI vendor was asked to generate an image of it" —
without picking a vendor, without generating a real image, and without
any of background removal, lifestyle/model generation, campaign imagery,
publishing, or billing.

The pipeline this phase establishes:

```
Source product (+ its Product Intelligence profile)
  → Generation request (services/generation/request-generation.server.ts)
      → GenerationJob row (PENDING → QUEUED)
          → BullMQ "generation" queue
              → processGenerationJob (PROCESSING)
                  → ImageGenerationProvider.generateImage
                  → StorageProvider.upload (temporary provider output →
                    persistent, referenced storage)
                  → GenerationResult row(s) (SUCCEEDED)
```

**No AI image generation of any kind happens in this codebase outside the
deterministic test provider.** No AI vendor SDK is installed. See
"Confirmations" at the end of this document.

## Generation domain (`services/generation/`)

Mirrors `services/intelligence/`'s shape (see docs/product-intelligence.md
for the established pattern this follows):

- `types.ts` — the generation taxonomy (`GENERATION_TYPES`), kept as an
  independent string-literal union so pure modules here don't need a
  Prisma import.
- `schema.ts` — `GenerationPlanSchema` (Zod), the structured request every
  generation is built from; `assertValidGenerateImageResult`, a light
  validation of a provider's raw output.
- `build-plan.ts` — pure mapping: product + Product Intelligence profile +
  chosen source images + generation type → `GenerationPlan`. The only
  place a prompt is synthesized.
- `build-input.ts` — pure mapping: a persisted `GenerationPlan` →
  `GenerateImageInput`, the shape `ImageGenerationProvider.generateImage`
  takes.
- `provider.server.ts` — resolves which `ImageGenerationProvider` to use.
- `deterministic-test-provider.server.ts` — test-only provider double.
- `job.server.ts` / `queue.server.ts` — the `"generation"` BullMQ job
  payload/processor and producer-side enqueue helper.
- `request-generation.server.ts` — the service entry point routes call.

Routes stay thin: `app/routes/app.products.$id.tsx`'s loader/action call
into this domain and render the result — no business logic, no direct
Prisma queries, no provider-specific code in the route itself (see
CLAUDE.md "Business logic does not live in UI routes").

## Provider abstraction

Extending `services/ai/`'s existing `AIProvider` (Product Intelligence's
`analyzeProduct`) with generation-specific methods was rejected in favor
of a **new, separate interface**: `ImageGenerationProvider.generateImage`.
Image generation and product analysis are unrelated capabilities with
unrelated input/output shapes; conflating them onto one `AIProvider` would
make "no vendor coupling" harder to keep true independently for each.

```ts
interface ImageGenerationProvider {
  readonly name: string;
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}
```

`GenerateImageInput` (services/ai/types.ts) carries: `generationType`,
`sourceImages` (reusing `ProductImageReference` from Phase 2), the
`productFacts`/`creativeDirection` split (see "Identity preservation"
below), `aspectRatio`, `outputFormat`, `quality`, `outputCount`, `attempt`
(which retry attempt this call represents — lets a provider treat retries
idempotently, and lets the deterministic test provider simulate "fails
once, then succeeds"), and an optional `brandStyle`.

`GenerateImageResult` carries one or more `GeneratedImageOutput` (`data:
Uint8Array` — temporary, provider-owned bytes; `contentType`; optional
`width`/`height`/`providerResultId`/`metadata`) plus an optional
`providerJobId`. The caller (`job.server.ts`) persists the bytes through
the storage abstraction — this interface never assumes where they end up.

No AI vendor SDK is installed. `UnconfiguredImageGenerationProvider`
(services/ai/unconfigured-provider.ts) is the default everywhere except
the deterministic test seam — same double-gate pattern as Phase 2's
`getConfiguredAIProvider` (`NODE_ENV === "test"` AND `AI_PROVIDER ===
"deterministic-test"`, both required).

## Processing abstraction (contracts only — nothing implemented)

`ImageProcessingProvider` (services/ai/types.ts) is a second, separate
interface for deterministic/transformative operations on an *existing*
image: `removeBackground`, `enhance`, `upscale`, `generateShadow`, `crop`,
`resize`. Generation is creative and provider/model-dependent; processing
is a deterministic transform — conflating the two (as an earlier draft of
`AIProvider` did, with `removeBackground`/`enhanceImage` alongside
`generateLifestyle`/`generateModelImage` all on one interface) made it
impossible to reason about or test them independently.

This phase only establishes the interface, its `ImageProcessingInput`/
`ImageProcessingOutput` contracts, and `UnconfiguredImageProcessingProvider`
(throws on every call). No real or test implementation, no resolver, no
queue job, no route calls into it. A future phase wires this in once
background removal/enhancement is actually being built.

## Generation data model

Reviewed the existing models (`ProductIntelligence`, `ShopifyProduct`)
and CLAUDE.md's "don't over-normalize simple AI attributes" guidance
before designing this. Landed on exactly two new models —
`GenerationJob` and `GenerationResult` — not the larger set an early
sketch of this phase suggested (`GenerationPreset`, `BrandStyle`,
`ModelPreset`, `MediaAsset` remain future-phase, undefined; see
docs/database.md).

**`GenerationJob` is both "GENERATION REQUEST" and "GENERATION JOB"** —
the pipeline's own two-stage language collapses onto one row. One
merchant action (Generate/Regenerate) creates exactly one row; a separate
`GenerationRequest` table would just duplicate it 1:1. Fields: `shop`
(tenant), `productId` (→ `ShopifyProduct`, cascade), `type`
(`GenerationType`), `status` (`GenerationStatus`), `sourceMediaIds`
(our internal `ShopifyProductMedia` ids), `plan` (the full, validated
`GenerationPlan`, snapshotted — see "Generation history"), `identityAnchors`
(denormalized off `plan.identityAnchors` for direct querying),
`errorMessage` (merchant-safe), `retryCount`, `providerName`,
`providerJobId`, `startedAt`/`completedAt`/`durationMs` (usage-accounting
foundation — see below), and `results` (the relation).

```prisma
enum GenerationType {
  PRODUCT_CLEANUP
  BACKGROUND_REMOVAL
  BACKGROUND_REPLACEMENT
  LIFESTYLE
  MODEL_SHOOT
  BANNER
  CATEGORY_BANNER
  CTA
  CAMPAIGN
}

enum GenerationStatus {
  PENDING
  QUEUED
  PROCESSING
  SUCCEEDED
  FAILED
  CANCELLED
}
```

**Generation types**: all nine are valid, schema-accepted values — the
taxonomy is established now so later phases don't need a migration to add
one. Only `PRODUCT_CLEANUP` is actually driven end to end this phase (the
"Generate Test Image" button, the deterministic test provider, all
tests). The rest have no dedicated plan-building/prompt logic yet.

**Status**: `PENDING` (row created, not yet enqueued) → `QUEUED`
(enqueued, waiting for a worker) → `PROCESSING` (a worker is calling the
provider — including during a BullMQ retry's backoff delay; there is
deliberately no separate `RETRYING` status, see "Retry semantics") →
`SUCCEEDED`/`FAILED`/`CANCELLED` (terminal). `CANCELLED` has no producer
yet this phase (no cancel action exists) — included so the column's
domain is complete from the start.

## Generation result model

A single job may produce multiple results — `GenerationResult` is a
separate table, one row per output, each independently identifiable
(`id`, own `createdAt`). Fields: `shop` (denormalized, like
`ShopifyProductMedia`/`ImageSelectionItem`), `generationJobId` (→
`GenerationJob`, cascade), `storageKey`, `url` (a reference string — a
signed URL captured at store time, never image bytes), `width`/`height`/
`format`, `providerName`/`providerResultId`, `metadata` (free-form
provider-reported detail).

**No image binaries in Postgres.** `storageKey`/`url` are references into
the `StorageProvider` abstraction — exactly like `ShopifyProductMedia`'s
`originalUrl`/`previewUrl` reference Shopify's CDN rather than embedding
bytes.

## Storage

Reused `lib/storage/`'s existing `StorageProvider` interface — no second
storage system. Added the one piece that was missing: a resolver,
`lib/storage/provider.server.ts`'s `getConfiguredStorageProvider()`,
mirroring `services/intelligence/provider.server.ts`'s shape for
`AIProvider`. No storage vendor SDK is installed (`OBJECT_STORAGE_PROVIDER`
is declared but unread — see `lib/validation/env.server.ts`), so this
currently always returns `MemoryStorageProvider` — its own doc comment
already anticipated exactly this ("any future local development without a
real bucket configured").

`job.server.ts`'s flow is "temporary provider output → persistent
application media": a provider's `GeneratedImageOutput.data` (raw bytes,
provider-owned, never assumed to live anywhere in particular) is uploaded
via `StorageProvider.upload`, then referenced by a `GenerationResult` row
(`storageKey` + a `getSignedUrl` reference) — never re-fetched from the
vendor, never re-derived.

**Known limitation**: `MemoryStorageProvider` holds objects in an
in-process `Map`, not a network-reachable store — it is NOT shared
across the web server and `workers/` process boundary. This is fine for
this phase's purpose (proving the upload → reference → persist plumbing;
integration/E2E tests construct the worker in-process specifically so
uploads and reads share the same `Map`) but means the UI cannot currently
render an actual `<img>` for a result in a real multi-process deployment
— see "UI" below. This stops applying automatically once a real storage
vendor is selected (`getConfiguredStorageProvider` is the only place that
changes).

## Generation plan

The structured bridge between Product Intelligence and image generation —
`GenerationPlanSchema` (Zod, `services/generation/schema.ts`):

```ts
{
  generationType, assetType,
  sourceProductId, sourceImages,
  productFacts: { identityAnchors },
  creativeDirection: { prompt, negativeConstraints, environment, lighting, composition },
  aspectRatio, outputFormat, quality, outputCount,
  modelConfiguration, brandStyle, constraints,
}
```

`build-plan.ts`'s `buildGenerationPlan` is the only place a plan is
constructed, from: the synced product (Phase 1), its Product Intelligence
profile (Phase 2, mandatory — see "Identity preservation"), the merchant's
chosen source images, and the generation type. It throws
`MissingSourceImagesError` if no requested media id resolves against the
product's own media, and `ProductNotAnalyzedError` if the product has no
`READY` Product Intelligence profile.

**No arbitrary prompts.** `creativeDirection.prompt` is always
system-synthesized from structured fields (category/material/color/style/
environment/photography style) — the UI never has a free-text prompt box,
and no route ever accepts raw prompt text from the browser. Two
narrow, non-route-facing escape hatches exist purely for tests:
`visualDirectionOverride` (structured creative-direction fields) and
`outputCountOverride` — both are parameters only code calling
`buildGenerationPlan`/`requestGeneration` directly (never the
merchant-facing action) can set; see those functions' doc comments.

## Identity preservation

The plan's `productFacts`/`creativeDirection` split is the explicit
"product facts vs. creative direction" distinction this phase requires:

- **`productFacts.identityAnchors`** — snapshotted directly from Product
  Intelligence's `IdentityAnchorsSchema` (Phase 2, reused, not
  redefined): category, shape, material, primary color, construction
  details, distinctive hardware, branding. Must remain stable — a red
  leather handbag's generation plan must never imply a different color,
  material, or shape.
- **`creativeDirection`** — environment, lighting, composition, and the
  synthesized prompt. Allowed, expected, to change between regenerations
  of the same product.

Mandatory, not optional: `buildGenerationPlan` requires a `READY` Product
Intelligence profile and throws `ProductNotAnalyzedError` otherwise —
generating without identity anchors would defeat the entire point of this
split, so this phase requires analysis first rather than silently
generating with `productFacts.identityAnchors: null`. (The Zod schema
still *permits* a null value structurally, since a provider's raw output
in principle could omit it — but the service layer's own guard is what
actually prevents it in the merchant-facing flow.)

`GenerateImageInput.productFacts` is typed as `Record<string, unknown>`
in `services/ai/types.ts` (not Product Intelligence's `IdentityAnchors`
type directly) — `services/ai/` must not depend on a higher domain layer;
only `services/generation/` knows the concrete shape.

**Not built this phase**: any validation that a generated image actually
respects its identity anchors. That's a stated future dependency of this
work, not something implemented here — see "Future relationship to
plans" below.

## Queue

Reused the existing `lib/queue/` factory (`createQueue`/`createWorker`) —
no new queue abstraction. Registered as `"generation"` in
`lib/queue/names.ts` (already reserved for this) and in
`workers/index.ts`'s `WORKER_REGISTRY`.

**Job id — deliberately different from Phase 1/2.** Those queues hash
`(shop, productId)`: stable per resource, so a *duplicate* request
collapses onto the same in-flight job, and a *completed* job's id becomes
reusable for the next legitimate one — correct for "analyze"/"sync"
(idempotent, one-current-result operations). Generation is not that: **a
merchant must be able to regenerate the same product any number of
times**, each an independent, preserved result. So this queue hashes
`(shop, generationJobId)` — and `generationJobId` is already unique per
request (`requestGeneration` always creates a fresh `GenerationJob` row).
There is no scenario where a regenerate could collide with a prior
request's queue job id.

**Retry — also deliberately different.** Phase 1/2's queues set no
`attempts` (a "retry" there is always an explicit new request). This
queue's producer (`queue.server.ts`) sets `attempts: 3` with exponential
backoff, so a transient provider error is retried automatically before a
merchant ever sees `FAILED`. `job.server.ts`'s catch block only calls
`markFailed` (persisting the terminal, merchant-visible state) once
`attempt >= totalAttempts` — during an in-progress retry sequence the row
stays `PROCESSING`, which is why `GenerationStatus` has no separate
`RETRYING` state. `retryCount` (bumped by `markProcessing` on every
attempt, including retries) is where that's visible instead.

**Idempotency / tenant isolation**: `processGenerationJob` re-verifies
shop ownership via `getGenerationJob`'s `assertShopOwnership` even though
its payload is server-derived (defense in depth, same pattern as Phase
2's job processor). A missing row (e.g. the product was deleted,
cascading its jobs away, between enqueue and processing) is a safe no-op,
not an error.

## Async generation flow

```
requestGeneration (route action, intent=generate)
  → findProductForShop (shop-verified) → getProductIntelligence
  → buildGenerationPlan → createGenerationJob (PENDING)
  → markQueued → enqueueGenerationJob
                                          [returns to the merchant]
      ↓ (worker process)
processGenerationJob
  → markProcessing (PROCESSING, startedAt set once)
  → getConfiguredImageGenerationProvider().generateImage(input)
  → assertValidGenerateImageResult (reject malformed output)
  → StorageProvider.upload each output → createResults
  → markSucceeded (SUCCEEDED, providerName/providerJobId/durationMs)

Failure (final attempt only):
  → markFailed (FAILED, one of three fixed, merchant-safe messages —
    never a raw provider error/stack trace)
  → rethrow (BullMQ has already scheduled retries for earlier attempts)
```

`markQueued` is written **before** `enqueueGenerationJob`, not after —
deliberately: the worker could start processing (and advance status
further) as soon as the job is enqueued, so writing `QUEUED` afterwards
would risk a stale write clobbering a newer status back to `QUEUED`.

## Generation types

`services/generation/types.ts`'s `GENERATION_TYPES` establishes room for
all nine values (mirrored exactly by `prisma/schema.prisma`'s
`GenerationType` enum — a unit test, `tests/unit/generation/types.test.ts`,
catches the two drifting apart). Only `PRODUCT_CLEANUP` has dedicated
prompt-synthesis logic and is reachable from the UI this phase — see
"Generation plan" above and CLAUDE.md "Incremental development".

## UI

A minimal "Image Generation" section on the product detail page
(`app/routes/app.products.$id.tsx`, alongside Phase 2's "Product
Intelligence" section): a status badge (`Not generated yet`/`Queued`/
`Processing`/`Succeeded`/`Failed`/`Cancelled`), a "Generate Test
Image"/"Regenerate" button (disabled until Product Intelligence is
`READY`, with a guiding note — the server enforces this regardless via
`ProductNotAnalyzedError`), a failure banner with the merchant-safe error
message, result cards once `SUCCEEDED`, and a compact generation-history
list once more than one generation exists.

Client-side polling mirrors Phase 2's `awaitingResult` pattern (armed at
click-time, disarmed at a terminal status) — see
app.products.$id.tsx's inline comments for why this is simpler here than
Phase 2's equivalent (every click creates a brand-new row, so there's no
"which state means not-started vs. a fresh request" ambiguity to work
around).

**Result cards show metadata (format, dimensions, provider), not a
rendered image.** The deterministic test provider — the only provider
wired up this phase — produces a 1x1 placeholder pixel, and
`MemoryStorageProvider`'s "URL" is a fake `memory://` reference, not a
fetchable one (see "Storage" above). Rendering an `<img>` against it would
just be a broken-image icon; the metadata card still proves results
persisted correctly. Becomes a real `<s-image>` once a real storage
vendor + AI provider are selected.

Not built (explicitly out of scope): a full studio UI, batch generation,
an advanced prompt editor, a model/pose selector, a campaign builder, a
source-image picker for generation (the test button always uses every one
of the product's current images), a Cancel action, and a
dedicated "Retry" action distinct from Regenerate (BullMQ's automatic
retry covers transient failures; a terminal `FAILED` job is retried by
requesting a fresh generation).

## Generation history

Every `requestGeneration` call creates a new `GenerationJob` row — never
an upsert, never an overwrite. A product accumulates Generation #1, #2,
#3, ... independently identifiable, each with its own results. This is
what a later phase's versioning/approval/rollback/comparison work builds
on; none of that is implemented here — the history existing and being
provably preserved (see `tests/e2e/generation.spec.ts`'s regenerate
assertion) is the whole of this phase's contribution to it.

## Usage tracking foundation

No billing, no credits, no subscription logic anywhere in this phase.
What's recorded, purely as structured metadata for a future phase to
read: `providerName`, `providerJobId` (per job) / `providerResultId` (per
result), `type` (generation type), `outputCount` (implicit — count of
`GenerationResult` rows), `durationMs`, and each result's own `metadata`
JSON (seed, model name, provider-specific detail). Nothing here computes
a cost, a credit deduction, or a plan/quota check.

## Security

- Every route entry point calls `requireAdminContext(request)` first;
  `requestGeneration`/`getGeneration`/`listGenerationHistory` all take
  the resulting `AuthContext` and re-verify shop ownership — a
  client-supplied product id or generation id is never trusted directly.
- A `TenantMismatchError` (resource exists, belongs to another shop) is
  converted to the same `ProductNotFoundError`/404 a genuinely missing
  product gets — never distinguishable, matching Phase 1/2's established
  "existence oracle" prevention pattern.
- Source media ids are never trusted directly: `buildGenerationPlan` only
  ever uses ids present in the already shop-verified `product.media`.
- No AI provider or storage vendor secret is ever read outside
  `lib/validation/env.server.ts` or exposed to a loader's returned data.
- Failures are logged in full (redacted) server-side; the merchant only
  ever sees one of three fixed, generic messages
  (`job.server.ts`'s `NOT_CONFIGURED_MESSAGE`/`INVALID_OUTPUT_MESSAGE`/
  `GENERIC_FAILURE_MESSAGE`) or the request-layer's own guiding messages
  (`MissingSourceImagesError`/`ProductNotAnalyzedError`).

## Testing

Unit: plan/schema validation, generation-type taxonomy drift, provider
input construction, identity-anchor propagation (`buildGenerationPlan`
carries `identityAnchors` through unchanged), the deterministic test
provider's determinism and forced-failure hooks.

Integration (real Postgres + Redis + an in-process BullMQ `Worker` + the
real `processGenerationJob` — the provider is the only thing substituted,
via the deterministic test seam, never the queue/storage/persistence):
repository lifecycle (`tests/integration/generation/generation-job.repository.test.ts`),
and full end-to-end (`tests/integration/generation/generation-queue.test.ts`)
covering success, multiple results, storage integration (downloads the
actually-uploaded object back out and asserts its bytes), provider
failure, automatic retry-then-succeed, regeneration/history preservation,
and tenant isolation.

Route: loader/action authorization
(`tests/integration/routes/app.products.id-generation-action.test.ts`) —
empty history, full request → succeeded flow through the route layer, the
guiding not-analyzed error, and the safe-404 cross-shop case.

E2E (`tests/e2e/generation.spec.ts`): Product → Generate Test Image →
queued/processing → succeeded → result visible → Regenerate → a second,
independent generation exists — using a real, in-process
`"generation"` worker exercising the real queue, exactly like
`tests/e2e/product-intelligence.spec.ts` established for Phase 2.

## Confirmations

- **No real AI provider was integrated.** No AI vendor SDK (OpenAI,
  Gemini, Replicate, Fal, Stability, ...) is installed or imported
  anywhere in this codebase. `getConfiguredImageGenerationProvider()`
  returns `UnconfiguredImageGenerationProvider` (throws on every call)
  everywhere except the double-gated, test-only deterministic provider.
- **No background-removal or other image-processing vendor was
  integrated.** `ImageProcessingProvider` is an interface and an
  `Unconfigured` implementation only — no resolver, no job, no route.
- **No commercial/billing logic was implemented.** No Stripe/Razorpay/
  etc. integration, no plan tiers, no credit deduction, no usage-limit
  enforcement — only the structured metadata a future phase would need
  to build that on top of.
- **No publishing back to Shopify.** Generated results stay in this
  app's own storage/database; nothing writes to a Shopify product's
  media.

## Future relationship to image validation and plans

This phase's `identityAnchors` propagation exists specifically so a
future phase can validate a generated result against it (e.g. "does this
output still show a red, leather, rectangular handbag with gold
hardware?") — no such validation exists yet; nothing here inspects
`GeneratedImageOutput.data` beyond the structural checks in
`assertValidGenerateImageResult` (non-empty bytes, a content type).
`GenerationPreset`/`BrandStyle`/`ModelPreset` (reusable, named
configurations built from a `GenerationPlan`-shaped foundation) remain
future-phase, undefined models — see docs/database.md and
docs/roadmap.md.
