# Architecture

## Overview

AI ImageShoot is a Shopify embedded app built on Shopify's current
recommended stack: **React Router 7** (server-rendered loaders/actions,
Vite-powered) with **TypeScript**, **Polaris** web components + **App
Bridge** for the embedded admin UI, the **Shopify Admin GraphQL API** for
catalog/merchant data, **PostgreSQL via Prisma** for our own persistence,
and **Redis via BullMQ** for background job processing.

The scaffold was generated from Shopify's official
`shopify-app-template-react-router` and then reorganized so that
Shopify-specific, AI-specific, storage-specific, and queue-specific code
each live behind a single, isolated boundary (see "Domain boundaries"
below and CLAUDE.md).

## Request flow

```
Browser (embedded admin UI, App Bridge)
  → React Router route (app/routes/*.tsx) — loader/action
      → services/shopify: requireAdminContext(request)
          → Shopify SDK: authenticate.admin — verifies session, returns
            { admin, session } and yields a provider-agnostic AuthContext
      → services/<domain>: business logic, given AuthContext
          → db/repositories/*: Prisma queries, shop-scoped
          → services/ai / lib/storage: behind their interfaces
      ← loader/action returns plain data
  ← route renders Polaris UI
```

Background work (once jobs exist) follows a parallel path: a
service enqueues a job via `lib/queue` → a separate `workers/` process
(started with `npm run worker`) picks it up and calls into the same
`services/*` modules.

## Why each boundary exists

- **`services/shopify/`** — the Shopify SDK (`shopifyApp()`, session
  storage, `authenticate`, Admin GraphQL client) is initialized exactly
  once, here. If Shopify's SDK ever changes shape, or we ever need to
  intercept/wrap Admin API calls (rate-limit handling, logging, retries),
  this is the only place that needs to change.
- **`services/ai/`** — no code outside this directory may import a
  specific AI vendor's SDK. Three focused interfaces live here —
  `AIProvider` (product analysis), `ImageGenerationProvider` (generative
  image creation), `ImageProcessingProvider` (deterministic transforms
  like background removal) — deliberately separate rather than one
  do-everything interface, since each is a genuinely different capability
  with a different input/output shape and may end up backed by different
  vendors. Everything else depends on these, so swapping or A/B-testing a
  vendor later doesn't ripple through generation logic, routes, or tests.
- **`services/intelligence/`** (Phase 2) — Product Intelligence's own
  business logic: building `AIProvider.analyzeProduct` input from synced
  catalog data, validating a provider's output, persistence orchestration,
  the BullMQ job/queue wiring, staleness detection, and category-aware
  generation recommendations. Depends on `services/ai/`'s `AIProvider`
  interface, never a vendor SDK — see docs/product-intelligence.md.
- **`services/generation/`** (Phase 3; extended Phases 5–7) — the
  image-generation foundation: building a structured `GenerationPlan`
  from a product + its Product Intelligence profile, the BullMQ job/queue
  wiring, and persisting results through the storage abstraction. Depends
  on `services/ai/`'s `ImageGenerationProvider` and
  `services/intelligence/`'s `IdentityAnchors` shape, never a vendor SDK
  — see docs/generation.md. Phase 5 extended this same domain with
  lifestyle scene planning (`LifestyleScenePlan`, nested in
  `GenerationPlan`), brand style presets (built-in constants + shop-saved
  custom `BrandStylePreset` rows), batch lifestyle generation
  (`GenerationBatch`), and an explicit identity-validation boundary. Phase
  6 added model imagery (`GenerationType.MODEL_SHOOT`, gated on Product
  Intelligence's `modelSuitable`, sharing the same `BrandStylePreset`) and
  merchant-selectable aspect ratio. Phase 7 began Package 3 (store
  visuals) with its product-scoped subset — `GenerationType.BANNER`/`CTA`,
  a promotional banner or CTA image still featuring one specific product
  (an explicit scoping decision — homepage/collection-level generation,
  which has no single owning product, stays deferred). Zero new Prisma
  models across all three phases — see docs/lifestyle-generation.md.
- **`services/store-visuals/`** (completion pass) — non-product-scoped
  generation (homepage hero/collection banner/store CTA): its own
  `StoreVisualJob`/`StoreVisualResult` model family (a sibling of
  `GenerationJob`/`GenerationResult`, not a nullable-`productId` reuse —
  see docs/store-visuals.md for why), a `"store-visuals"` BullMQ queue
  built on the same factory, and a `StoreVisualPlanSchema` that reuses
  `GenerationPlanSchema`'s building blocks without inheriting its
  mandatory-one-product shape. Reuses the AI provider abstraction,
  storage, review lifecycle, and brand style presets unchanged.
- **`services/creative-studio/`** (Creative Studio pass) — the
  conversational image creation/editing workspace: turns a merchant's
  natural-language message into a structured `ParsedIntent`
  (`services/ai/heuristic-intent-parser.ts` — a real, rule-based default,
  not gated to tests like every other provider seam), derives a compact
  `CreativeContext` from a `CreativeSession`'s own history, and builds a
  `GenerationPlan` with `generationType: "CREATIVE_STUDIO"` — the SAME
  `GenerationJob`/`GenerationResult` pipeline every other generationType
  already uses, not a second one. See docs/creative-studio.md.
- **`services/usage/entitlement.server.ts`** — the reserve/settle/refund
  credit lifecycle (`CreditReservation`, now `operationType`-aware),
  separate from `services/usage/usage-accounting.server.ts`'s audit
  ledger. Every billable operation across all four domains (product
  analysis, image generation, image processing, store visual generation)
  is credit-gated — see docs/usage.md. `getPlan`/`canUseOperation`/
  `getRemainingCredits` resolve a shop's real plan via
  `services/billing/`.
- **`services/billing/`** (commercial-readiness pass) — the
  subscription-plan domain: `plans.ts` (FREE/STARTER/PRO/BUSINESS code
  -constant catalog), `shopify-billing-provider.server.ts` (the second
  file in this codebase allowed to define a GraphQL mutation —
  `appSubscriptionCreate`/`appSubscriptionCancel`, gated by Partners
  billing config, not `access_scopes`), `subscription.server.ts`
  (orchestration + `ShopSubscription`/`BillingEvent` persistence). See
  docs/billing.md.
- **`services/assets/`** (completion pass) — the shop-wide AI Assets
  library: merges `GenerationResult`/`ProcessingResult`/`StoreVisualResult`
  into one normalized, filterable, paginated, newest-first list. No new
  Prisma model — a bounded-fetch, in-application merge across the three
  existing result tables, not a raw SQL `UNION`. See docs/asset-library.md.
- **`services/processing/`** (Phase 4) — production image processing
  (background removal/enhance/resize): building provider input from a
  source image + validated options, the `"enhancement"` BullMQ job/queue
  wiring (batch and single-image), and persisting results through the
  storage abstraction. Depends on `services/ai/`'s
  `ImageProcessingProvider` (its production implementation is the first
  real vendor call anywhere in this codebase — remove.bg, for background
  removal only) and reuses Phase 1's `ImageSelection` for batch requests
  — see docs/image-processing.md.
- **`lib/storage/`** — same reasoning as AI, for object storage
  (S3/R2/Cloudinary/...). `StorageProvider` (`lib/storage/types.ts`) is
  the contract. No real cloud vendor is wired up yet;
  `getConfiguredStorageProvider()` (`lib/storage/provider.server.ts`)
  defaults to `LocalFilesystemStorageProvider` (Phase 4) — genuinely
  persistent and shared across the web/worker process boundary on one
  host, but not horizontally-scale-ready; see docs/image-processing.md
  "Local filesystem storage vs. production storage considerations".
  Serving a processed image to the browser (which can't carry Shopify's
  session-token auth on a plain `<img>` load) goes through a dedicated,
  HMAC-signed `/media/*` route (`app/routes/media.$.tsx`, deliberately
  outside `app.tsx`'s auth-requiring layout) — see docs/image-processing.md
  "Signed media URL architecture".
- **`lib/queue/`** — all BullMQ `Queue`/`Worker` construction and the
  shared Redis connection live here, so production settings (e.g.
  `maxRetriesPerRequest: null`, connection reuse) are set once, correctly,
  rather than repeated at every call site.
- **`db/repositories/`** — the only code allowed to write Prisma queries.
  Services depend on repositories, not on `@prisma/client` directly, so
  shop-ownership checks (`lib/auth/tenant.server.ts`) live in one place
  per model rather than being re-implemented at every call site.
- **`lib/auth/`** — `AuthContext` is deliberately not a Shopify SDK type.
  Everything downstream of authentication (repositories, services, future
  queue jobs) depends on this small, stable shape (`{ shop, sessionId,
  isOnline }`), not on `@shopify/shopify-app-react-router`'s session type.
- **`lib/validation/env.server.ts`** — the only file allowed to read
  `process.env` for a declared variable. Fails fast, at boot, with every
  problem listed at once, instead of a confusing runtime error deep in a
  request.
- **`lib/logging/logger.server.ts`** — the only logging entry point;
  redacts secret-shaped keys/values before anything is serialized (see
  CLAUDE.md "Security requirements").

## Configuration

All environment variables are declared and validated in
`lib/validation/env.server.ts` (Zod schema). Nothing else in the codebase
should read `process.env.SOMETHING` directly for a variable declared
there — import `getEnv()` instead. See `.env.example` for the full list
and `docs/database.md`/`docs/ai-pipeline.md` for how DB/AI-related
variables are used.

## Framework conventions vs. domain isolation

React Router expects certain files at conventional relative paths
(`app/shopify.server.ts`, `app/db.server.ts`, referenced via `../shopify.server`
and `../db.server` from route modules). Rather than fight that convention
or scatter imports across the codebase, those two files are kept as thin
re-exports:

- `app/shopify.server.ts` → re-exports `services/shopify/client.server.ts`
- `app/db.server.ts` → re-exports `db/client.server.ts`

The real implementation lives in the owning domain directory in both
cases; `app/` never contains Shopify SDK initialization or Prisma client
construction itself.

## What's deliberately not built yet

See `docs/roadmap.md` for the phase plan. Phase 0 is infrastructure only —
Phase 1 added Shopify catalog sync and product/image selection. Phase 2
added Product Intelligence (`services/intelligence/`, see
docs/product-intelligence.md) — structured per-product analysis and
generation recommendations, with no vendor wired up. Phase 3 added the
image-generation foundation (`services/generation/`, see
docs/generation.md) — the request → job → provider → storage → result
pipeline, proven end to end only via a deterministic test provider, no
real AI vendor installed. Phase 4 added production image processing
(`services/processing/`, see docs/image-processing.md) — the Basic
plan's background removal/enhance/resize, batch processing (reusing
Phase 1's `ImageSelection`), review (Approve/Reject/Regenerate), and
`ProcessingBatch`/`ProcessingJob`/`ProcessingResult` — the first phase
with a real, working vendor call (remove.bg, background removal only)
and real persistent storage (`LocalFilesystemStorageProvider`, not yet a
cloud vendor). Phase 5 added AI lifestyle product imagery (`GenerationType.LIFESTYLE`,
see docs/lifestyle-generation.md) — category-aware scene planning, brand
style presets (built-in + shop-saved custom), batch lifestyle generation,
review/regeneration/history, and an explicit (currently non-semantic)
identity-validation boundary. Phase 6 completed the same "Package 2"
capability set with `GenerationType.MODEL_SHOOT` (model photography,
gated on Product Intelligence's `modelSuitable`, sharing the same
`BrandStylePreset`) and merchant-selectable aspect ratio, unifying the
product detail page's lifestyle/model UI into one "AI Product Imagery"
section. Phase 7 began "Package 3" (store visuals) with its
product-scoped subset — `GenerationType.BANNER`/`CTA`, reusing the same
architecture, no text/logo rendering — while explicitly deferring
homepage/collection-level generation (no single owning product; this app
doesn't sync Shopify collections either) pending its own architectural
decision. Zero new Prisma migrations across Phases 6–7. The productization pass
added Store Visuals, brand style preset management, the AI Assets
library, GDPR compliance webhooks, and a Shopify publishing foundation
(`services/publishing/` — the real `productCreateMedia` mutation exists,
but `write_products` is deliberately not requested yet, so publishing
honestly fails rather than faking success; see docs/publishing.md).

The Creative Studio pass (see docs/creative-studio.md) added the
conversational image creation/editing workspace
(`services/creative-studio/`, `/app/creative/:sessionId`) — one
`CreativeSession` per ongoing conversation, natural language parsed into
structured intent by a real (heuristic, not-yet-AI) default parser, image
-to-image follow-ups, multiple variations per turn, and a credit
reserve/settle/refund foundation (`services/usage/entitlement.server.ts`).
Generation itself still ran only through the deterministic test
provider — no real image-generation vendor installed, and no real
subscription/billing plan existed (the credit allowance was one flat,
clearly-labeled development default).

**The commercial-readiness pass** (see docs/usage.md, docs/billing.md)
closed most of that gap: a real, testable
`ProductionImageGenerationProvider` HTTP client (text-to-image AND
image-to-image/editing, mode-aware model selection), a real-LLM
`IntentParsingProvider` with heuristic fallback, a structured
"creative-override" mechanism for explicit non-critical-attribute
changes, a real per-operation credit-cost table replacing the flat
1-credit guess, credit gating extended to ALL FOUR billable domains (not
just Creative Studio), a real `services/billing/` subscription-plan
domain (FREE/STARTER/PRO/BUSINESS) backed by the Shopify Billing API
(`appSubscriptionCreate`/`appSubscriptionCancel`, no new OAuth scope),
and `/app/billing`. No specific commercial AI vendor is still named or
credentialed anywhere in this repository — the HTTP clients are real and
working against documented, vendor-agnostic contracts, but no live
vendor account exists in this environment, so generation/intent-parsing
still run through the deterministic/heuristic providers in practice.
Still no homepage/collection banners or campaign generation, still no
Shopify product-media publishing (`write_products` deliberately not
requested). Per-plan output-count/batch-size/resolution limits are all
enforced (see docs/billing.md "Known limitations" for exactly how each
one is enforced — output-count/batch-size by rejection,
resolution by clamping at the provider layer).
