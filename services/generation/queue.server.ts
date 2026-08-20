/**
 * Producer-side helper for the `"generation"` queue. Routes/services call
 * this instead of constructing a BullMQ `Queue` themselves (see CLAUDE.md
 * "Queue rules" — all `Queue`/`Worker` construction goes through
 * `lib/queue`).
 */
import { createQueue } from "../../lib/queue";
import { generationBullJobId, type GenerationJobPayload } from "./job.server";

/** Automatic retry for transient provider failures — see job.server.ts's
 * module doc comment for why this queue (unlike Phase 1/2's) sets this,
 * and why the `GenerationStatus` enum doesn't need a separate "RETRYING"
 * state to support it. */
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
};

let queue: ReturnType<typeof createQueue<GenerationJobPayload>> | undefined;

function getQueue() {
  if (!queue) {
    queue = createQueue<GenerationJobPayload>("generation");
  }
  return queue;
}

/**
 * Enqueues a generation job. `generationBullJobId` is unique per request
 * (built from the already-unique `GenerationJob.id` — see job.server.ts),
 * so this is never a dedup collapse the way Phase 1/2's `(shop,
 * productId)`-keyed jobs are: every call here always gets a real, running
 * job, which is exactly what "a merchant must be able to regenerate"
 * requires.
 */
export async function enqueueGenerationJob(payload: GenerationJobPayload): Promise<void> {
  await getQueue().add("generate", payload, { jobId: generationBullJobId(payload), ...JOB_OPTIONS });
}
