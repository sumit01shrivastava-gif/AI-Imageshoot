# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository.
Read this before making changes. If something here conflicts with what you
observe in the code, the code wins — update this file to match reality
rather than trusting a stale description.

## Product overview

**AI ImageShoot** is a Shopify embedded app: an AI Product Photography
Studio for Shopify merchants. Eventually it will let merchants:

- Import Shopify products and select product images
- Remove/replace backgrounds, clean up and enhance images
- Generate lifestyle imagery and AI-model imagery
- Generate multiple aspect ratios and run batch generations
- Review/approve generated assets and maintain asset versions
- Publish approved assets back to Shopify
- Track AI usage and credits

## Current phase

**Phase 4 — Production Image Processing (Basic Plan Foundation) —
complete.** Phase 0 (foundation), Phase 1 (Shopify product catalog sync,
search/detail, image selection), Phase 2 (Product Intelligence, no vendor
wired up), and Phase 3 (image-generation foundation — `GenerationJob`/
`GenerationResult`, `ImageGenerationProvider`/`ImageProcessingProvider`
abstractions, the `"generation"` queue, proven only via a deterministic
test provider) are done. Phase 4 is the **first phase with a real,
working AI vendor call**: `ProductionImageProcessingProvider`
(`services/ai/production-image-processing-provider.server.ts`) calls
remove.bg for background removal; enhancement and resizing run locally
via `sharp` (no vendor needed for deterministic transforms). It adds
`ProcessingJob`/`ProcessingResult`/`ProcessingBatch` models (a dedicated
family, not a reuse of `GenerationJob`/`GenerationResult` — see
docs/image-processing.md for why), the `"enhancement"` BullMQ queue
(single-image and batch, with automatic retry), batch processing built
on Phase 1's existing `ImageSelection`, a review lifecycle (Approve/
Reject/Regenerate — never overwrites a prior result), replaces
`MemoryStorageProvider` with a genuinely persistent
`LocalFilesystemStorageProvider` as the storage default, and a signed,
tenant-authorized `/media/*` route for serving processed images to the
browser (which can't carry Shopify's session-token auth on a plain
`<img>` load). See docs/image-processing.md. **No real AI *generation*
vendor is installed (only the one processing vendor, remove.bg, for
background removal); no lifestyle/AI-model/campaign imagery; no
publishing back to Shopify; no credits/billing/subscriptions; and
`LocalFilesystemStorageProvider` is not yet a horizontally-scalable cloud
storage vendor.**

## ⚠️ Incremental development — read this before doing anything

This project is built in explicit, numbered phases, each scoped by the
person directing the work. **Do not implement a future phase's features
because they're described in the product overview, this file, or
docs/roadmap.md.** Those documents describe where the project is *going*,
not a backlog to pick up unprompted. If you're unsure whether something is
in scope for the current phase, ask rather than assume.

When a phase is complete: update "Current phase" and "Current
implementation status" below, and stop — do not continue into the next
phase's work in the same pass unless explicitly instructed to.

## Technology stack

- **Framework**: Shopify App with React Router 7 (current Shopify-recommended
  template — the successor to their Remix template)
- **Language**: TypeScript, `strict: true`
- **UI**: Shopify Polaris (web components, e.g. `<s-page>`, `<s-button>`) +
  App Bridge React (`@shopify/app-bridge-react`)
- **Shopify integration**: `@shopify/shopify-app-react-router`, Admin
  GraphQL API (not REST — see "Shopify API rules")
- **Database**: PostgreSQL via Prisma (`@prisma/client`)
- **Queue**: Redis via BullMQ
- **Testing**: Vitest (unit/integration), Playwright (e2e)
- **Package manager**: npm (canonical — see `.npmrc`, `engine-strict=true`)

Do not add a second framework/library that overlaps one already chosen
above (e.g. a second ORM, a second queue library, a second UI kit) without
it being an explicit instruction.

## Architecture principles

1. **Shopify integration is isolated.** All Shopify SDK usage
   (`shopifyApp()`, `authenticate`, Admin GraphQL calls) lives in
   `services/shopify/`. Routes and other services import from
   `services/shopify`, never from `@shopify/shopify-app-react-router`
   directly.
2. **AI providers are isolated.** All AI vendor calls happen behind the
   `AIProvider` interface in `services/ai/types.ts`. No other module may
   import a specific AI vendor's SDK.
3. **Storage is isolated.** All object storage happens behind the
   `StorageProvider` interface in `lib/storage/types.ts`. No other module
   may import a specific storage vendor's SDK (S3, R2, Cloudinary, ...).
4. **Queue infrastructure is isolated.** All BullMQ usage goes through
   `lib/queue/`. Job payload shapes and processors live in
   `services/*`/`workers/`, not scattered across routes.
5. **Business logic does not live in UI routes.** `app/routes/*` loaders
   and actions should call into `services/*`/`db/repositories/*` and
   render the result — they should not contain business rules, direct
   Prisma queries, or provider-specific code.
6. **Provider-specific code never leaks into business logic.** A
   `services/generation` function, for example, should be able to run
   against any `AIProvider` implementation and any `StorageProvider`
   implementation without modification.

## Domain boundaries (directory map)

```
app/                  React Router app: routes, root, entry, thin re-exports
  routes/             Loaders/actions — call services/, render UI, no business logic
  components/         Shared UI components (promote here once 2+ routes need one)

services/
  shopify/            ALL Shopify SDK usage (auth, admin client, webhooks)
  ai/                 AIProvider/ImageGenerationProvider/ImageProcessingProvider
                       interfaces; ProductionImageProcessingProvider (Phase 4 —
                       remove.bg for background removal, local sharp for
                       enhance/resize) is the only real vendor-backed provider
                       implemented so far. Unconfigured* fallbacks for the rest.
  products/           Product import/selection business logic (future)
  intelligence/       Product Intelligence: analysis input/output, schema
                       validation, queue/job, staleness, recommendations
                       (services/intelligence/README.md)
  generation/         Image generation foundation: generation plan, job/
                      queue, provider input, storage persistence
                      (services/generation/README.md)
  processing/         Production image processing (Basic plan): operation
                       taxonomy, options schema, job/queue (single-image +
                       batch), review lifecycle (services/processing/README.md)
  media/              Media library business logic (future)
  publishing/         Publish-to-Shopify business logic (future)
  usage/              Usage/credit tracking business logic (future)

db/
  client.server.ts    Prisma client singleton (canonical — app/db.server.ts re-exports it)
  repositories/       One module per domain model, wraps Prisma queries

workers/               BullMQ worker process entry point (separate from the web server)

lib/
  auth/               Provider-agnostic AuthContext type + tenant isolation guard
  queue/               Redis connection + BullMQ queue/worker factories
  storage/              StorageProvider interface; LocalFilesystemStorageProvider
                        (Phase 4 default — persistent, not yet a cloud vendor) +
                        in-memory test implementation
  validation/           Environment schema (Zod) — the only place process.env is read
  logging/               Structured logger with secret redaction

tests/
  unit/ integration/ e2e/

docs/                  Architecture and domain documentation (this directory)
```

If Shopify's own framework conventions pull a file to a specific location
(e.g. `app/shopify.server.ts` must exist at that relative path for route
imports), keep a thin re-export there and put the real implementation in
the owning domain directory above — see `app/shopify.server.ts` and
`app/db.server.ts` for the pattern.

## Security requirements

- **Server-side authentication only.** Every loader/action touching
  merchant data calls `requireAdminContext(request)`
  (`services/shopify/admin-context.server.ts`), which wraps
  `authenticate.admin` from the Shopify SDK.
- **Shop/tenant isolation is mandatory.** Never trust a `shopId`,
  `userId`, `productId`, `generationId`, or any other ownership identifier
  supplied by the browser. Every repository/service function that loads a
  resource by a client-supplied id must verify shop ownership using the
  server-derived `AuthContext` — see `lib/auth/tenant.server.ts`'s
  `assertShopOwnership`.
- **No secrets in client-side code.** Nothing under `SECRET_ENV_KEYS`
  (`lib/validation/env.server.ts`) may be passed to a loader's returned
  data, a component prop, or bundled into client JS.
- **No sensitive values in logs.** Use `logger` from
  `lib/logging/logger.server.ts`, not `console.*` directly — it redacts
  secret-shaped keys/values automatically.
- **Environment secrets stay out of git.** `.env` is gitignored;
  `.env.example` holds placeholders only, never real credentials.
- **Input validation.** Validate external input (env vars via
  `lib/validation/env.server.ts`; request input, once routes accept it,
  with an explicit schema) rather than trusting shapes implicitly.
- **Safe error handling.** Merchant-facing errors must be understandable
  and must not leak internal stack traces, query text, or provider
  responses. Log full detail server-side (redacted); return a summarized
  message to the client.

## Testing requirements

- **Unit tests** (`tests/unit/`): pure logic — env validation, mapping
  functions, pagination/upsert logic, auth/tenant guards — with providers
  mocked. No network calls.
- **Integration tests** (`tests/integration/`): a route/service boundary
  with its direct dependencies (e.g. a mocked Shopify SDK module, a real
  Prisma client against a local database), verifying wiring, not vendor
  behavior.
- **E2E tests** (`tests/e2e/`, Playwright): real user flows. Never call a
  live/production Shopify store or a real AI provider from automated
  tests — use fixtures/mocks.
- Do not write tests whose only assertion is that a mock returns what you
  told it to return — test the code that consumes the mock.
- Do not suppress a failing test to make a run green; fix the cause or
  remove the test if it no longer applies.

## Shopify API rules

- Use the **Admin GraphQL API**. Do not add new functionality against the
  deprecated REST Admin API.
- Use the API version configured in `services/shopify/client.server.ts`
  (`ApiVersion.October25` at time of writing) and `shopify.app.toml`
  (`[webhooks].api_version`) — keep both in sync when bumping.
- Request the **minimum scopes** required for the feature being built
  (`shopify.app.toml`'s `[access_scopes]`). Justify any scope addition in
  the PR/commit description.
- All Shopify calls go through `services/shopify/` — see "Architecture
  principles".
- Webhook handlers (`app/routes/webhooks.*`) must verify the Shopify
  HMAC/session via `authenticate.webhook`, must be idempotent (safe to
  receive the same event twice), and must be shop-scoped.

## AI provider rules

- No AI vendor SDK is installed or called yet. When one is added, it must
  implement `AIProvider` (`services/ai/types.ts`) and live in
  `services/ai/`; nothing outside `services/ai/` may import the vendor SDK
  directly.
- Never make a real AI API call from a test.
- AI provider credentials are read only via `lib/validation/env.server.ts`
  (`AI_PROVIDER_API_KEY` etc.), never hardcoded.

## Storage rules

- No storage vendor SDK is installed yet. When one is added, it must
  implement `StorageProvider` (`lib/storage/types.ts`); nothing outside
  `lib/storage/` may import the vendor SDK directly.
- Shopify-hosted image URLs are never treated as permanent
  application-owned assets — Shopify remains the source of truth for
  original merchant media until we explicitly ingest something into our
  own storage (a later phase).
- Original Shopify-hosted images are never modified or overwritten by this
  app.

## Queue rules

- All BullMQ `Queue`/`Worker` construction goes through
  `lib/queue/queue.server.ts` (`createQueue`/`createWorker`) so the shared
  Redis connection (`lib/queue/connection.server.ts`) and its BullMQ
  production settings stay in one place.
- Queue names are declared centrally in `lib/queue/names.ts`
  (`QUEUE_NAMES`) — don't invent a queue name inline.
- Worker processors are registered in `workers/index.ts`'s
  `WORKER_REGISTRY`; job logic itself lives in the owning `services/*`
  module, not inline in the worker file.
- Job processors must be idempotent where the queue's at-least-once
  delivery semantics make that possible.

## Database rules

- Prisma schema lives in `prisma/schema.prisma`; the client is
  constructed once in `db/client.server.ts` (everything else imports that
  singleton, including `app/db.server.ts`'s re-export).
- The `Session` model's shape is dictated by
  `@shopify/shopify-app-session-storage-prisma` — don't rename its fields
  or change their types.
- One repository module per domain model under `db/repositories/`;
  services call repositories, not Prisma directly.
- Every repository function that loads a resource by a client-supplied id
  must take the caller's `AuthContext` and call `assertShopOwnership`
  before returning data — see "Security requirements".
- Migrations are generated with `prisma migrate dev` against a real local
  Postgres (see `docker-compose.yml`) and committed; never hand-edit a
  generated migration file.
- Don't copy more of Shopify's catalog into our database than the app
  actually needs (UI, AI processing, generation jobs, asset management) —
  Shopify remains the source of truth for the merchant's catalog.

## Development workflow

1. `cp .env.example .env` and fill in local values.
2. `docker compose up -d` — starts local Postgres (host port 5433) and
   Redis (host port 6380); see the port comments in `docker-compose.yml`
   for why they're non-default (this machine may run other projects on
   5432/6379).
3. `npm install`
4. `npm run setup` (Prisma generate + migrate deploy) or `npx prisma
   migrate dev` when authoring a new migration.
5. `npm run dev` — runs `shopify app dev` (requires `shopify app config
   link` first, once this project is linked to a real app in Partners).
6. `npm run worker` — starts the BullMQ worker process, when there are
   workers registered to run.

Before considering a change done: `npm run typecheck`, `npm run lint`,
`npm test`, `npm run build`. Do not leave known TypeScript errors and do
not suppress errors (`@ts-ignore`, `eslint-disable`) just to make a run
pass — fix the underlying issue or explain in-code why the suppression is
correct.

## Git workflow

- `main` is the default branch. Confirm before pushing to a remote unless
  explicitly told to push.
- Group a phase's work into one clean commit (or a small number of
  logically-scoped commits) with a `type: summary` message
  (`feat: ...`, `fix: ...`, `docs: ...`).
- Before committing: review the diff, confirm no `.env` or other secret
  file is staged, confirm no generated output (`node_modules`, `build/`,
  `.react-router/`, lockfiles for package managers we don't use) is
  staged.

## Current implementation status

Phase 0 (foundation) — complete:

- [x] Shopify app scaffold (React Router 7, TypeScript, Polaris, App
      Bridge, `@shopify/shopify-app-react-router`)
- [x] Environment validation, `.gitignore`, `.env.example`
- [x] Prisma + PostgreSQL — `Session` model only
- [x] AI provider abstraction (`services/ai`) — no vendor wired up
- [x] Storage abstraction (`lib/storage`) — no vendor wired up
- [x] Queue foundation (`lib/queue`, `workers/`) — no jobs registered
- [x] Domain-separated directory structure
- [x] Security foundation (env validation, tenant isolation guard, admin
      auth wrapper, redacting logger)
- [x] This documentation set
- [x] Dependencies installed, `typecheck`/`lint`/`test`/`build` verified
      green, foundation committed

Phase 1 (Shopify product catalog) — complete:

- [x] Shopify product catalog sync (`services/products/`, `read_products`
      scope only), search/detail routes, image selection UI
- [x] Catalog sync queue (`lib/queue`) with hardened job-id/dedup
      semantics

Phase 2 (Product Intelligence engine) — complete:

- [x] `ProductIntelligence` Prisma model — one profile per product,
      versioned, tenant-isolated, derived staleness (no persisted STALE
      state)
- [x] `services/intelligence/` — analysis input building, Zod-validated
      output schema (`ProductIntelligenceSchema`, mandatory
      `identityAnchors`), category-aware recommendation table, staleness
      detection
- [x] `AIProvider.analyzeProduct` extended on the existing abstraction —
      no vendor SDK installed; double-gated deterministic test provider
      for tests only
- [x] `"product-intelligence"` BullMQ queue reusing the shared
      `lib/queue/` factory and hardened job-id/dedup semantics
- [x] Product detail page: Analyze/Re-analyze Product, status states,
      structured profile display — merchant-triggered only, no bulk/auto
      analysis
- [x] docs/product-intelligence.md

Phase 3 (Image generation foundation) — complete:

- [x] `GenerationJob`/`GenerationResult` Prisma models — generation
      history preserved (never overwritten), multiple results per job,
      tenant-isolated
- [x] `services/ai/` split into three focused interfaces — `AIProvider`
      (analysis), `ImageGenerationProvider` (generation),
      `ImageProcessingProvider` (deterministic transforms, abstraction
      only, nothing calls it yet) — no vendor SDK installed for any of
      them
- [x] `services/generation/` — structured `GenerationPlan` (explicit
      product-facts-vs-creative-direction split for identity
      preservation), provider input building, double-gated deterministic
      test provider for tests only
- [x] `"generation"` BullMQ queue reusing the shared `lib/queue/` factory
      — per-request (not per-product) job ids so regeneration is always a
      real job, plus automatic retry on transient provider failure
- [x] `lib/storage/provider.server.ts` — storage provider resolver
      (in-memory default; no vendor selected yet)
- [x] Product detail page: Generate Test Image/Regenerate, status states,
      result metadata, generation history — merchant-triggered only, no
      bulk/batch generation
- [x] docs/generation.md

No real AI *generation* vendor is installed — every generation in this
codebase runs only through the deterministic test provider, never a live
network call. (Phase 4 below adds one real *processing* vendor call —
these remain separate abstractions; see docs/generation.md and
docs/image-processing.md.)

Phase 4 (Production image processing — Basic plan foundation) — complete:

- [x] `ProcessingJob`/`ProcessingResult`/`ProcessingBatch` Prisma models —
      a dedicated family (not a `GenerationJob`/`GenerationResult` reuse
      — see docs/image-processing.md for why), processing history
      preserved (never overwritten), tenant-isolated, batch progress
      computed at read time (never a persisted counter)
- [x] `ProductionImageProcessingProvider`
      (`services/ai/production-image-processing-provider.server.ts`) —
      the first real, working AI vendor call anywhere in this codebase:
      remove.bg for `REMOVE_BACKGROUND`; `ENHANCE`/`RESIZE` run locally
      via `sharp` (no vendor needed); `UPSCALE`/`GENERATE_SHADOW`/`CROP`
      remain interface-only
- [x] `services/processing/` — options schema, provider input building,
      double-gated deterministic test provider for tests only, batch
      entry point built on Phase 1's `ImageSelection`
- [x] `"enhancement"` BullMQ queue (single-image + batch), per-request
      job ids, automatic retry on transient provider failure
- [x] `lib/storage/local-filesystem-provider.server.ts` — replaces
      `MemoryStorageProvider` as the default: genuinely persistent,
      shared across the web/worker process boundary on one host, not yet
      a horizontally-scalable cloud vendor
- [x] `app/routes/media.$.tsx` — signed, tenant-authorized media serving
      (HMAC-signed `/media/*`, deliberately outside `app.tsx`'s
      session-auth layout, since a plain `<img>` load can't carry it)
- [x] Review lifecycle — Approve/Reject/Regenerate, never overwrites a
      prior result
- [x] Product detail page "Image Processing" section + a new batch
      progress/review page (`app/routes/app.processing.$batchId.tsx`),
      reached by extending Phase 1's existing selection flow — no new
      selection UI built
- [x] docs/image-processing.md

No real AI *generation* vendor, no lifestyle/AI-model/campaign imagery,
no publishing back to Shopify, no credits/billing/subscriptions is
implemented. See docs/roadmap.md.
