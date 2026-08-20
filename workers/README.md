# Workers

This is the entry point for BullMQ worker processes — a separate Node
process from the React Router web server (started with `npm run worker`,
see `workers/index.ts`), so long-running/CPU- or IO-heavy job processing
never blocks request handling.

`workers/index.ts` registers one worker as of Phase 1: `"catalog-sync"`,
processed by `services/products/sync-job.server.ts`'s
`processCatalogSyncJob` (full/incremental catalog sync, and the
webhook-triggered single-product upsert/delete — see
docs/shopify-integration.md "Webhooks" and services/products/sync.server.ts).
`"generation"`, `"enhancement"`, and `"publishing"` (see `lib/queue/names.ts`)
remain unregistered until the phases that need them; docs/generation-pipeline.md
describes what each will eventually do.

To add a worker in a later phase:

1. Implement the job logic in the relevant `services/*` module.
2. Add an entry to `WORKER_REGISTRY` in `workers/index.ts` pairing a
   `QueueName` with a `Processor` function.
3. Nothing else changes — `workers/index.ts` starts whatever is registered.
