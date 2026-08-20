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
- **`services/generation/`** (Phase 3) — the image-generation foundation:
  building a structured `GenerationPlan` from a product + its Product
  Intelligence profile, the BullMQ job/queue wiring, and persisting
  results through the storage abstraction. Depends on `services/ai/`'s
  `ImageGenerationProvider` and `services/intelligence/`'s
  `IdentityAnchors` shape, never a vendor SDK — see docs/generation.md.
- **`lib/storage/`** — same reasoning as AI, for object storage
  (S3/R2/Cloudinary/...). `StorageProvider` (`lib/storage/types.ts`) is
  the contract. No real vendor is wired up yet;
  `getConfiguredStorageProvider()` (`lib/storage/provider.server.ts`)
  defaults to the in-memory implementation in the meantime.
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
pipeline, proven end to end only via a deterministic test provider. No
real AI vendor (image generation or image processing), no publishing back
to Shopify, and no credits/billing exists yet.
