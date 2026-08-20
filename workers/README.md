# Workers

This is the entry point for BullMQ worker processes — a separate Node
process from the React Router web server (started with `npm run worker`,
see `workers/index.ts`), so long-running/CPU- or IO-heavy job processing
never blocks request handling.

`workers/index.ts` currently starts zero workers: `WORKER_REGISTRY` is
empty. No queue has a processor yet — see `lib/queue/names.ts` for the
queue names reserved for later phases (`generation`, `enhancement`,
`publishing`) and docs/generation-pipeline.md for what each will do.

To add a worker in a later phase:

1. Implement the job logic in the relevant `services/*` module.
2. Add an entry to `WORKER_REGISTRY` in `workers/index.ts` pairing a
   `QueueName` with a `Processor` function.
3. Nothing else changes — `workers/index.ts` starts whatever is registered.
