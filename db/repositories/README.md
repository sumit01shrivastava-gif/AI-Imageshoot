# Repositories

This directory will hold one repository module per domain model, each
wrapping Prisma queries for that model behind a small, purpose-built
function set (e.g. `findById`, `listForShop`, `create`) — so services never
import `db/client.server` or write raw Prisma queries directly.

No domain models exist yet (Phase 0 only defines the `Session` table
required by Shopify auth — see `prisma/schema.prisma`), so there are no
repositories yet. Expect one file per model here once the corresponding
domain model is added, e.g.:

- `product-asset.repository.ts` — `ProductAsset`
- `generation-job.repository.ts` — `GenerationJob`
- `media-asset.repository.ts` — `MediaAsset`
- `credit-balance.repository.ts` — `CreditBalance`
- ...and so on for the remaining models listed in docs/database.md and
  docs/roadmap.md.

Every repository function that loads a resource by an id supplied by a
client must take the caller's `AuthContext` (see `lib/auth/types.ts`) and
call `assertShopOwnership` before returning the resource — see
`lib/auth/tenant.server.ts`.
