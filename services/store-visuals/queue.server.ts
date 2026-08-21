/**
 * Producer-side helper for the `"store-visuals"` queue — mirrors
 * services/generation/queue.server.ts exactly (same automatic-retry
 * rationale, same `(shop, jobId)`-keyed job id so regeneration is never
 * collapsed).
 */
import { createQueue } from "../../lib/queue";
import { storeVisualBullJobId, type StoreVisualJobPayload } from "./job.server";

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
};

let queue: ReturnType<typeof createQueue<StoreVisualJobPayload>> | undefined;

function getQueue() {
  if (!queue) {
    queue = createQueue<StoreVisualJobPayload>("store-visuals");
  }
  return queue;
}

export async function enqueueStoreVisualJob(payload: StoreVisualJobPayload): Promise<void> {
  await getQueue().add("generate", payload, { jobId: storeVisualBullJobId(payload), ...JOB_OPTIONS });
}
