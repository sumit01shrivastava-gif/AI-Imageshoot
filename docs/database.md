# Database

## Current state (Phase 0)

`prisma/schema.prisma` defines exactly one model: `Session`, required
as-is by `@shopify/shopify-app-session-storage-prisma` for Shopify OAuth
session storage. Field names/types must not change — the session storage
adapter depends on this exact shape. An index on `shop` was added (safe:
it doesn't change the adapter contract) since shop-scoped lookups are the
basis of tenant isolation throughout the app.

No domain model exists yet.

## Client

`db/client.server.ts` constructs the single `PrismaClient` instance the
whole app shares (cached on `global` outside production, to survive Vite
dev-server module reloads without exhausting Postgres connections).
`app/db.server.ts` re-exports it unchanged so route modules can use the
conventional `../db.server` import — see docs/architecture.md.

## Repositories

`db/repositories/` will hold one module per domain model, each wrapping
Prisma queries behind a small function set (`findById`, `listForShop`,
`create`, ...). Services depend on repositories, never on
`db/client.server` or raw Prisma queries directly. This is where
`assertShopOwnership` (`lib/auth/tenant.server.ts`) gets called for any
lookup keyed by a client-supplied id — see CLAUDE.md "Security
requirements".

Empty in Phase 0 — no domain model exists to wrap yet.

## Planned domain models (future phases — NOT implemented yet)

Listed here so the eventual shape is documented; do not create these
ahead of the phase that needs them:

- `ProductAsset`, `ProductIdentity` — synchronized Shopify product data and
  our own product-level metadata
- `GenerationJob`, `GenerationResult`, `GenerationPreset` — AI generation
  requests, their outputs, and reusable presets
- `BrandStyle`, `ModelPreset` — merchant-defined generation configuration
- `MediaAsset`, `MediaVersion` — our own storage-backed assets and their
  version history (see docs/ai-pipeline.md for why Shopify-hosted URLs
  aren't treated as `MediaAsset`s)
- `UsageRecord`, `CreditBalance`, `CreditTransaction` — AI usage/credit
  accounting
- `Publication` — records of assets published back to Shopify
- `AuditLog` — auditable record of sensitive actions

## Migrations

Generate migrations with `npx prisma migrate dev` against a real local
Postgres (`docker-compose.yml` starts one on host port 5433 — see the
comment in that file for why it's not the default 5432). Commit the
generated `prisma/migrations/*` directory; never hand-edit a generated
migration SQL file. Deploy with `prisma migrate deploy` (wired into `npm
run setup` and the Docker image's `docker-start` script).

## Why Shopify's catalog isn't fully mirrored

Shopify remains the source of truth for the merchant's catalog. Our
database stores only what's needed for efficient UI rendering, AI
processing inputs, synchronization bookkeeping (last-synced timestamps),
relationships between our own records, and generation-job/asset
management — not a full copy of every Shopify product field. See
docs/roadmap.md for when catalog sync is introduced.
