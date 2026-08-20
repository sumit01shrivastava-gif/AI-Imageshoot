# Production Image Processing (Phase 4 — Basic Plan Foundation)

## Purpose

Phase 4 builds the first real merchant-facing capability of AI ImageShoot:
turning an existing Shopify product image into a clean, ecommerce-ready
asset — background removal, light cleanup/enhancement, and aspect-ratio
resizing — with a batch workflow, a review step (Approve/Reject/
Regenerate), and full history. This is the "Basic plan": deterministic,
non-creative transforms of a merchant's own images, not AI-generated
imagery. Phases 2/3 built the layers this depends on (Product
Intelligence, the generation foundation); this phase is the first one
that can actually change a pixel a merchant will use.

## Supported operations

`ImageProcessingProvider` (`services/ai/types.ts`, established in Phase
3) defines six operations. Phase 4 implements three of them for real,
behind `ProductionImageProcessingProvider`
(`services/ai/production-image-processing-provider.server.ts`):

| Operation | Implemented? | How |
|---|---|---|
| `REMOVE_BACKGROUND` | ✅ | remove.bg (real vendor call) |
| `ENHANCE` | ✅ | local, via `sharp` (no vendor) |
| `RESIZE` | ✅ | local, via `sharp` (no vendor) |
| `UPSCALE` | ❌ interface only | throws `UnconfiguredAIProviderError` |
| `GENERATE_SHADOW` | ❌ interface only | throws `UnconfiguredAIProviderError` |
| `CROP` | ❌ interface only | throws `UnconfiguredAIProviderError` |

All six are valid, schema-accepted `ImageOperation` values (the taxonomy
is established in full, matching the same "establish room for more than
you implement" pattern Phase 3 used for `GenerationType`) — only the
first three have a UI entry point, a queue path, and a real
implementation. `services/processing/types.ts`'s `IMPLEMENTED_OPERATIONS`
is the definitive list of which; a unit test
(`tests/unit/processing/types.test.ts`) keeps the six-value taxonomy in
sync with `prisma/schema.prisma`'s `ImageOperation` enum.

## Provider selection

**Background removal → remove.bg.** A single REST endpoint
(`POST https://api.remove.bg/v1.0/removebg`), API-key auth, does exactly
one thing well — "the smallest reliable provider integration required for
Phase 4" for the one operation that genuinely needs ML (a plain `fetch()`
call, no SDK to install). Gated on `REMOVE_BG_API_KEY` being set; without
it, `removeBackground` throws `UnconfiguredAIProviderError` even when
`IMAGE_PROCESSING_PROVIDER` selects the production provider for the other
operations.

**Enhance / resize → local, no vendor.** Sharpening, lighting correction
(mild `.normalize()`), and aspect-ratio cropping/resizing are
deterministic image operations — they don't need a model call at all.
Using `sharp` (a well-established, zero-network Node image library)
instead of routing these through an AI vendor is a deliberate choice, not
an oversight: it's more reliable (no external dependency, no per-call
cost, nothing to rate-limit), and "do not over-process the product" (see
"Image cleanup" below) is easier to guarantee with a fixed, conservative
local transform than an opaque model call.

**Upscale / shadow / crop → not implemented.** Not required by the Phase
4 checklist. `UPSCALE` genuinely needs ML (naive resampling isn't real
upscaling); `GENERATE_SHADOW`/`CROP` are deferred, not because they're
hard, but because they weren't asked for this phase.

No AI vendor SDK is installed for anything — `ProductionImageProcessingProvider`
makes plain `fetch()` calls and uses `sharp`, nothing else. Credentials
(`REMOVE_BG_API_KEY`) are read only via `lib/validation/env.server.ts`,
never hardcoded, never logged (`SECRET_ENV_KEYS`). No real vendor call
happens from a test — `services/processing/provider.server.ts`'s
double-gated deterministic seam (`NODE_ENV === "test"` AND
`IMAGE_PROCESSING_PROVIDER === "deterministic-test"`, both required) is
what every test actually exercises.

## Architecture

```
Merchant action (per-image, product detail page — OR batch, via
Products → select → Review & Continue → choose operation)
  → services/processing/request-processing.server.ts
      (requestProcessing / batch.server.ts's startBatchProcessing)
      → shop-verified product + media lookup (never trusts a
        client-supplied id)
      → best-effort Product Intelligence identityAnchors snapshot
      → createAndEnqueueProcessingJob
          → ProcessingJob row (PENDING → QUEUED)
          → "enhancement" BullMQ queue
                                          [returns to the merchant]
      ↓ (worker process)
services/processing/job.server.ts's processProcessingJob (PROCESSING)
  → getConfiguredImageProcessingProvider().<operation>(input)
  → assertValidProcessingOutput (reject malformed output)
  → StorageProvider.upload the output → ProcessingResult row (SUCCEEDED)
```

Routes stay thin: `app/routes/app.products.$id.tsx` and
`app/routes/app.processing.$batchId.tsx` only call into
`services/processing/`, never touch Prisma or a provider directly (see
CLAUDE.md "Business logic does not live in UI routes").

### `services/processing/`

- `types.ts` — the operation taxonomy (`IMAGE_OPERATIONS`,
  `IMPLEMENTED_OPERATIONS`) and aspect-ratio presets, independent of
  `@prisma/client`.
- `schema.ts` — `ProcessingOptionsSchema` (Zod, strict — operation
  options are `{ aspectRatio? }` today, nothing else) and
  `assertValidProcessingOutput`.
- `build-input.ts` — pure mapping: a source image reference + validated
  options → `ImageProcessingInput`.
- `provider.server.ts` — resolves the provider (production / test /
  unconfigured — see "Provider selection").
- `deterministic-test-provider.server.ts` — test-only provider double
  (see "Testing").
- `job.server.ts` / `queue.server.ts` — the `"enhancement"` BullMQ job
  payload/processor and its enqueue helper.
- `request-processing.server.ts` — single-image entry point
  (`requestProcessing`, `getProcessing`, `listProcessingHistory`,
  `reviewProcessingResult`) plus the shared `createAndEnqueueProcessingJob`
  primitive both this and `batch.server.ts` build on.
- `batch.server.ts` — batch entry point (`startBatchProcessing`,
  `getBatchSummary`), consuming Phase 1's `ImageSelection`.

## Processing lifecycle

`PENDING` (row created) → `QUEUED` (enqueued) → `PROCESSING` (a worker is
calling the provider — including during a BullMQ retry's backoff delay;
there is no separate `RETRYING` status) → `SUCCEEDED` / `FAILED` /
`CANCELLED` (terminal; `CANCELLED` has no producer yet — no cancel action
exists this phase, included so the column's domain is complete). Same
five-terminal-plus-in-flight shape as `GenerationStatus`
(Phase 3) — kept as its own `ProcessingStatus` enum rather than reusing
that one, following this schema's established one-enum-per-domain-model
precedent (`ProductStatus`, `SyncStatus`, `IntelligenceStatus`,
`GenerationStatus` are all already separate).

`markQueued` runs **before** `enqueueProcessingJob`, not after —
deliberately: the worker could start processing as soon as the job is
enqueued, so writing `QUEUED` afterwards risks a stale write clobbering a
newer status back to `QUEUED`. Same reasoning as
`docs/generation.md`'s identical ordering.

## `ProcessingBatch` / `ProcessingJob` / `ProcessingResult`

**A dedicated model family — not a reuse of `GenerationJob`/
`GenerationResult`.** Reviewed before building: a processing job is a
*deterministic* transform of *one* existing image (no prompt, no creative
plan, no multi-image input), while `GenerationJob.plan` is a rich,
creative `GenerationPlan` (prompt, environment, brand style, ...) that
doesn't apply here. Forcing both into one table would make `plan`'s
meaning ambiguous and force `GenerationType` to represent two different
kinds of taxonomy (creative asset category vs. deterministic operation)
at once. The *pattern* — one row per request, never overwritten,
tenant-isolated, status lifecycle, a results relation — is deliberately
copied from `GenerationJob`/`GenerationResult` (architectural
consistency), just not literal table reuse.

```
ProcessingBatch  (optional — only exists for a batch-started request)
  └─ ProcessingJob × N   (one per source image; batchId nullable —
      null for a single-image product-detail request)
       └─ ProcessingResult × 1 (almost always exactly one; modeled as a
           relation, not a 1:1, for the same reason GenerationResult is —
           independently identifiable/queryable/reviewable without
           special-casing "the" result on the job row)
```

- **`ProcessingJob`** — `shop` (tenant), `productId`, `sourceMediaId`
  (exactly one, unlike `GenerationJob.sourceMediaIds[]`), `operation`,
  `status`, `options` (validated `ProcessingOptions`), `identityAnchors`
  (best-effort snapshot — see "Identity preservation"), `errorMessage`,
  `retryCount`, `providerName`, `providerJobId`, `startedAt`/
  `completedAt`/`durationMs`, `batchId` (nullable).
- **`ProcessingResult`** — `shop`, `processingJobId`, `storageKey`, `url`
  (a signed reference — see "Signed media URL architecture"), `width`/
  `height`/`format`, `providerName`/`providerResultId`, `metadata`,
  `reviewStatus`/`reviewedAt` (see "Review lifecycle").
- **`ProcessingBatch`** — `shop`, `operation`, `sourceSelectionId`
  (traceability only — the batch's own jobs are the source of truth once
  created). Progress (total/pending/queued/processing/succeeded/failed/
  cancelled) is **computed at read time** via a `groupBy` over
  `ProcessingJob.status` scoped to the batch
  (`db/repositories/processing-batch.repository.ts`'s `getBatchProgress`)
  — never a persisted counter, so it can never drift from the jobs
  themselves (same "derive, don't duplicate" principle as
  `services/intelligence/stale.ts`'s staleness check).

Every job/result/batch query that loads by a client-supplied id verifies
shop ownership (`assertShopOwnership`/`TenantMismatchError`) before
returning data — see "Tenant isolation".

## Provider abstraction

`ImageProcessingProvider` (established in Phase 3, made production-real
this phase) is deliberately separate from `ImageGenerationProvider`:
generation is creative and provider/model-dependent; processing is a
deterministic transform of an existing image. `ImageProcessingInput
{ sourceImage: ProductImageReference, options?: Record<string, unknown> }`
→ `ImageProcessingOutput { data: Uint8Array, contentType, width?, height?,
metadata? }` — raw, provider-owned bytes; `job.server.ts` persists them
through the storage abstraction, never assuming where they end up.

## Storage abstraction

Reused `lib/storage/`'s existing `StorageProvider` interface — no second
storage system. **Phase 3 used `MemoryStorageProvider`** (an in-process
`Map`, not actually persistent, not shared across the web/worker process
boundary). **Phase 4 replaces it as the default** with
`LocalFilesystemStorageProvider`
(`lib/storage/local-filesystem-provider.server.ts`):

- Writes to `STORAGE_LOCAL_ROOT` (env-configurable, default
  `.data/storage`, gitignored).
- **Genuinely persistent** — survives a process restart.
- **Shared across the web server and `workers/` process boundary** — as
  long as both point at the same `STORAGE_LOCAL_ROOT` on the same host
  (true of this app's deployment today), a real filesystem is naturally
  shared between OS processes the way an in-process `Map` never was.
  This directly resolves the cross-process limitation Phase 3's
  documentation flagged.
- Defensive path-traversal protection: every key is resolved against the
  configured root and rejected if it would escape it.
- `MemoryStorageProvider` still exists, exported, usable directly in pure
  unit tests that want a fake — it's just no longer what
  `getConfiguredStorageProvider()` returns by default.

### Local filesystem storage vs. production storage considerations

**`LocalFilesystemStorageProvider` is suitable for local development,
testing, and a single-instance deployment. It is NOT the final
architecture for a horizontally scaled deployment.** If the web server
and worker ever run as multiple replicas without a shared filesystem/
volume (the typical shape of a horizontally scaled container deployment),
a file one instance writes won't be visible to a request another instance
serves. This phase does not solve that — it was explicitly out of scope
("do not implement an external storage vendor in this phase unless one
already exists in the repository", and no credentials for one exist in
this environment anyway). The fix is a real object-storage vendor (S3/
R2/GCS/...) implementing the same `StorageProvider` interface — nothing
outside `lib/storage/` would need to change; `getConfiguredStorageProvider()`
(`lib/storage/provider.server.ts`) is the one place that picks the
implementation, by design, specifically so this swap doesn't ripple into
`services/processing/`, `services/generation/`, or any route.
`OBJECT_STORAGE_PROVIDER`/`OBJECT_STORAGE_BUCKET`/`OBJECT_STORAGE_ENDPOINT`/
`OBJECT_STORAGE_ACCESS_KEY`/`OBJECT_STORAGE_SECRET_KEY` are already
declared in `lib/validation/env.server.ts` for exactly that future
vendor, unread until one is selected.

## Signed media URL architecture

A plain `<img src>`/`<s-image src>` load can't carry Shopify's
session-token bearer auth (there's no way to attach an Authorization
header to a browser-initiated image fetch) — so serving a processed
image can't sit behind the normal `requireAdminContext` auth path the
rest of the app uses.

Instead: `StorageProvider.getSignedUrl({ key, expiresInSeconds,
operation: "get" })` returns a **time-limited, HMAC-signed** `/media/<key>
?expires=<epoch-ms>&sig=<hex>` path
(`lib/storage/local-filesystem-provider.server.ts`). The signature is
computed over `key:expiresAt` with a server-only secret
(`MEDIA_SIGNING_SECRET`, falling back to a domain-separated derivation of
`SHOPIFY_API_SECRET` if unset) — it can only have been produced by
server code that already loaded the owning `ProcessingResult`/
`GenerationResult` row through a shop-scoped, ownership-checked
repository function. The signature itself **is** the authorization; there
is no separate database lookup in the serving route, because the
ownership check already happened at the point the URL was generated.

`app/routes/media.$.tsx` — deliberately a **top-level** route
(`media.$.tsx`, sibling to `auth.$.tsx`/`webhooks.*.tsx`), **not** nested
under `app.tsx` (whose loader calls `requireAdminContext` for every route
that nests under it, which would break unauthenticated image loads) —
verifies `sig`/`expires` (`verifyMediaUrlSignature`, using
`node:crypto`'s `timingSafeEqual`) and streams the object's bytes with
its stored content type. A wrong/missing/expired signature and a
genuinely missing object return the same generic 404 — never
distinguishable, matching this codebase's "existence oracle" prevention
pattern. **No filesystem path is ever exposed** — the URL carries an
opaque storage key and a signature, never a real disk path, and
`LocalFilesystemStorageProvider` itself refuses to resolve a key outside
its configured root regardless.

This is a genuinely different mechanism from a cloud vendor's own
pre-signed URLs (which are cryptographically bound to the vendor's own
infrastructure) — it's a local equivalent that provides the same
guarantee (time-limited, tenant-authorized, unforgeable without the
server secret) without one. A future real storage vendor would likely
return its own native signed URL from `getSignedUrl` instead, and
`media.$.tsx` would simply stop being in the URL for that path — nothing
else changes.

## Review lifecycle

Every `ProcessingResult` starts `reviewStatus: PENDING`. A merchant can
**Approve** or **Reject** (`reviewProcessingResult` →
`setResultReviewStatus`, which verifies the result belongs to the
caller's shop before updating, updating `reviewStatus`/`reviewedAt` on
that exact row — the result id, not a description, is what's approved).
**Rejecting never deletes the result** — it stays in history, still
inspectable, just marked. There is no "history of review decisions" to
preserve beyond the current `reviewStatus`/`reviewedAt` — reversing a
decision (Reject → Approve) is a plain update, not a new row, since the
underlying asset itself never changes across a review decision.

## Regeneration / versioning

**A new processing result never overwrites an older one.** Every
`requestProcessing`/batch/regenerate call creates a **new**
`ProcessingJob` row (`createAndEnqueueProcessingJob` — see "Architecture")
— never an upsert. A product accumulates Process #1, #2, #3, ...,
independently identifiable, each with its own result(s) and its own
review state. "Regenerate" (both the batch review page and the product
detail page) looks up the original job server-side and creates a fresh
job with the exact same product/source image/operation/options — carrying
the original's `batchId` forward if it had one, so a regenerated batch
job stays visible in the same batch view. The original job/result is
never touched.

## Identity preservation

`ProcessingJob.identityAnchors` is a **best-effort** snapshot of the
product's Product Intelligence identity anchors (category, material,
color, shape, construction, hardware, branding) at request time, when a
`READY` profile exists — reused directly from
`services/intelligence/schema.ts`'s `IdentityAnchorsSchema`, not
reinvented. Unlike Phase 3's `GenerationJob` (which **requires** a
`READY` profile and refuses to proceed without one — generation is
creative and needs the constraint), processing is **never blocked** on
Product Intelligence: a deterministic transform (crop/sharpen/background
removal) doesn't invent anything, so it's identity-safe by construction —
it only ever touches pixels, never re-interprets what the product is. The
anchors are recorded when available purely for traceability/future
validation tooling, not as a precondition. Regardless: none of the three
implemented operations are permitted to (and none of their
implementations do) intentionally alter material, color, shape,
construction, hardware, or branding — background removal isolates the
subject, enhancement is a mild sharpen/normalize, resize is a centered
crop-to-fit. The original image is always the authoritative source
(`sourceMediaId` always points at the original `ShopifyProductMedia`,
never a prior `ProcessingResult` — no operation chains off a previous
processed output).

## Original-image preservation

**Original Shopify images are never modified.** No code path in
`services/processing/` ever calls `prisma.shopifyProductMedia.update`/
`.delete`, and no Shopify Admin API mutation is ever issued (this app
still only requests `read_products`; no write scope exists). Every
operation reads `ShopifyProductMedia.originalUrl` and writes a **new**
`ProcessingResult` row referencing a **new** storage object — the
original is untouched at every layer: the database row, the Shopify CDN
URL it points at, and the actual Shopify-hosted file. Verified directly
in integration tests (`tests/integration/processing/processing-queue.test.ts`
et al. assert `ShopifyProductMedia.originalUrl` is byte-identical before
and after a job, including a failed one) and in the E2E flow.

## Retry behavior

Deliberately different from Phase 1/2's queues (no automatic BullMQ
retry there — a repeat is always an explicit new request): the
`"enhancement"` queue's producer (`queue.server.ts`) sets `attempts: 3`
with exponential backoff, so a transient provider error (a flaky remove.bg
call, a momentary network blip) is retried automatically before the
merchant ever sees `FAILED`. `job.server.ts`'s catch block only calls
`markFailed` (the terminal, merchant-visible state) once `attempt >=
totalAttempts`; during an in-progress retry sequence the row stays
`PROCESSING`. `retryCount` (bumped by `markProcessing` on every attempt)
is where the attempt number is visible. Job ids hash `(shop,
processingJobId)` — not `(shop, productId)` — so a regenerate is always a
brand-new job, never collapsed with a prior one (same reasoning as
`docs/generation.md`'s "Queue" section).

## Tenant isolation

Every processing lookup/action is scoped to the authenticated shop:

- `requestProcessing`/`createAndEnqueueProcessingJob` re-verify the
  product via `findProductForShop` (throws/converts `TenantMismatchError`
  to the same `ProductNotFoundError`/404 a genuinely missing product
  gets — never distinguishable).
- A source media id is never trusted directly: only proceeds if it
  appears in the already shop-verified product's own media
  (`SourceImageNotFoundError` otherwise).
- `getProcessing`/`getBatch` call `assertShopOwnership` before returning
  a row — a cross-shop job/batch id throws `TenantMismatchError`, mapped
  to the same safe 404 at the route layer.
- `setResultReviewStatus` checks `result.shop === context.shop` itself
  (returns `false`, never updates, for a mismatch) rather than trusting a
  client-supplied result id.
- The worker (`job.server.ts`), even though its payload is
  server-derived, still re-verifies via shop-scoped repository calls —
  defense in depth, matching Phase 2/3's job processors.
- Signed media URLs are the *output* of an already-ownership-checked
  read, not a second ownership check — see "Signed media URL
  architecture".

Regression tests for all of the above live in
`tests/integration/processing/*.test.ts` and
`tests/integration/routes/app.processing.batch-action.test.ts` /
`app.products.id-processing-action.test.ts`.

## UI

**Product detail page** (`app/routes/app.products.$id.tsx`, "Image
Processing" section): every one of the product's Shopify images, each
with Remove background/Enhance/Resize buttons (only the three
implemented operations are offered); a "Latest result" card (original vs.
processed, operation, dimensions, status, created time, Approve/Reject/
Regenerate) once the most recent request succeeds; a compact processing
history list (operation, status, review state, dimensions, created time,
per-product "Process #N" versioning) for everything before it. Polling
(`awaitingProcessing` + a 3s interval, disarmed at a terminal status)
mirrors the exact pattern already established for Product Intelligence/
Generation on this same page — never polls once a job is
`SUCCEEDED`/`FAILED`/`CANCELLED`.

**Batch progress + review** (`app/routes/app.processing.$batchId.tsx`):
status, total/queued/processing/succeeded/failed counts, completion
percentage, a card per job (original vs. processed, operation,
dimensions, status, created time, Approve/Reject/Regenerate) — reached
by extending Phase 1's existing "Products → select → Review & Continue"
flow (`app/routes/app.products.selection.tsx`) with an operation picker
and "Start processing" button, rather than building a second selection
UI.

Not built (explicitly out of scope): a full studio UI, an aspect-ratio
picker in the quick-action buttons (RESIZE defaults to `1:1`), a Cancel
action, a dedicated "Retry" action distinct from Regenerate (automatic
BullMQ retry covers transient failures; a terminal `FAILED` job is
retried by requesting a fresh regeneration).

## Testing

Unit: operation taxonomy drift (mirrors the Prisma enum), options schema
validation, output validation, provider-input construction, the
deterministic test provider's determinism and forced-failure hooks, the
local filesystem storage provider's upload/download/delete/signed-URL/
signature-verification/path-traversal behavior.

Integration (real Postgres + Redis + an in-process BullMQ `Worker` + the
real `processProcessingJob` + a real scratch-directory
`LocalFilesystemStorageProvider` — only the vendor call is substituted,
via the deterministic test seam, never the queue/storage/persistence):
repository lifecycle, batch progress computation, full end-to-end
(success, storage round-trip via a real download of the uploaded bytes,
provider failure, automatic retry-then-succeed, regeneration/history
preservation, tenant isolation, original-media preservation), batch
processing (multiple products, one job failing during processing without
blocking the others — a batch finishing partially-succeeded), and route
-level authorization for both the batch page and the product detail
page's processing actions.

E2E: Products → select multiple → choose Background Removal → start
processing → batch progress → completed results → review → approve →
regenerate → verify the previous result remains, using a real
in-process `"enhancement"` worker exercising the real queue (never
mocked) — plus a signed-media-URL fetch assertion (confirms the served
bytes/content-type, and that a tampered signature is rejected). A second
E2E test covers the product-detail flow: open a product → see its source
image → start background removal → observe processing → see the
completed result → verify the original still exists (checked directly in
the database) → approve → regenerate → verify the previous result
remains in the processing history.

## Basic plan boundary (what this phase does NOT do)

No lifestyle backgrounds, AI lifestyle generation, human/model
generation, poses, props, category banners, website banners, CTA images,
campaign generation, Shopify publishing, billing, subscriptions, credits,
or plan enforcement. No real AI image-*generation* vendor — the only real
vendor call anywhere in this codebase is remove.bg's background-removal
endpoint; `ImageGenerationProvider` (Phase 3) still has no real
implementation. Those are all later phases.

## Current limitations

- `LocalFilesystemStorageProvider` is not horizontally-scale-ready — see
  "Local filesystem storage vs. production storage considerations".
- `UPSCALE`/`GENERATE_SHADOW`/`CROP` are interface-only.
- No aspect-ratio picker in the UI — `RESIZE` always uses `1:1` from the
  quick-action buttons (the underlying service/schema support `4:5`/
  `16:9` too; nothing in the UI exposes them yet).
- No Cancel action, no separate "Retry" action (automatic BullMQ retry
  + Regenerate cover this phase's needs).
- `enhance`/`resize` fetch the source image via a plain `fetch()` call to
  its Shopify CDN URL — no timeout/size-limit handling beyond what
  `fetch()` and the surrounding job's own attempt/retry semantics
  already provide.
- No approval-driven downstream action (e.g. nothing consumes an
  `APPROVED` result yet — publishing back to Shopify is a future phase).
