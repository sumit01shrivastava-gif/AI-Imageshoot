/**
 * Producer-side helpers for the `"catalog-sync"` queue. Routes/webhook
 * handlers call these instead of constructing a BullMQ `Queue` themselves
 * (see CLAUDE.md "Queue rules" — all `Queue`/`Worker` construction goes
 * through `lib/queue`).
 */
import { createQueue } from "../../lib/queue";
import { catalogSyncJobId, type CatalogSyncJobPayload } from "./sync-job.server";

let queue: ReturnType<typeof createQueue<CatalogSyncJobPayload>> | undefined;

function getQueue() {
  if (!queue) {
    queue = createQueue<CatalogSyncJobPayload>("catalog-sync");
  }
  return queue;
}

/** Enqueues a catalog-sync job. Uses a deterministic job id
 * (`catalogSyncJobId`) so a burst of repeat triggers (e.g. Shopify
 * redelivering the same webhook) collapses into one queued job rather than
 * piling up duplicate work — BullMQ treats adding a job with an id that's
 * still active/waiting as a no-op. */
export async function enqueueCatalogSync(payload: CatalogSyncJobPayload): Promise<void> {
  await getQueue().add(payload.type, payload, { jobId: catalogSyncJobId(payload) });
}
