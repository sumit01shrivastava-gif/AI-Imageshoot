# services/products

Product catalog sync + source-image-selection business logic (Phase 1):

- `mapping.ts` — pure Shopify GraphQL node → `SyncedProduct` mapping (no I/O).
- `shopify-queries.server.ts` — the domain's Admin GraphQL query documents +
  fetch wrappers, built on `services/shopify`'s transport helper.
- `sync.server.ts` — full/incremental catalog sync orchestration, and the
  single-product upsert/delete used by the webhook path.
- `sync-job.server.ts` / `sync-queue.server.ts` — the `"catalog-sync"` BullMQ
  job payload/processor and its producer-side enqueue helper.
- `selection.server.ts` — validates and persists a merchant's chosen source
  images as an `ImageSelection` (see prisma/schema.prisma).
- `webhook-payload.ts` — pure helper for reading a product id out of a
  products/* webhook payload.
- `types.ts` — shared types for this domain.

See docs/shopify-integration.md and docs/database.md for the sync/selection
architecture. AI generation itself (`ProductAsset`/`GenerationJob` and the
rest of the AI pipeline) is still a future phase — see docs/roadmap.md.
