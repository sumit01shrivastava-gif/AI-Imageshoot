/**
 * Producer-side helper for the `"product-intelligence"` queue. Routes call
 * this instead of constructing a BullMQ `Queue` themselves (see CLAUDE.md
 * "Queue rules" — all `Queue`/`Worker` construction goes through
 * `lib/queue`).
 */
import { createQueue } from "../../lib/queue";
import { productIntelligenceJobId, type ProductIntelligenceJobPayload } from "./job.server";

let queue: ReturnType<typeof createQueue<ProductIntelligenceJobPayload>> | undefined;

function getQueue() {
  if (!queue) {
    queue = createQueue<ProductIntelligenceJobPayload>("product-intelligence");
  }
  return queue;
}

/** Enqueues a product-analysis job. Deterministic job id (see
 * `lib/queue/job-id.ts`) collapses duplicate in-flight requests (e.g. a
 * merchant double-clicking "Analyze") onto one job, while still letting a
 * completed/failed job's id be reused for the next legitimate request —
 * see `lib/queue/queue.server.ts`'s doc comment. */
export async function enqueueProductIntelligenceAnalysis(
  payload: ProductIntelligenceJobPayload,
): Promise<void> {
  await getQueue().add("analyze", payload, { jobId: productIntelligenceJobId(payload) });
}
