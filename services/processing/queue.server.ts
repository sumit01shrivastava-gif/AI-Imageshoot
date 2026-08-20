/**
 * Producer-side helper for the `"enhancement"` queue. Routes/services call
 * this instead of constructing a BullMQ `Queue` themselves (see CLAUDE.md
 * "Queue rules" — all `Queue`/`Worker` construction goes through
 * `lib/queue`).
 */
import { createQueue } from "../../lib/queue";
import { processingBullJobId, type ProcessingJobPayload } from "./job.server";

/** Automatic retry for transient provider failures — same reasoning as
 * services/generation/queue.server.ts's `JOB_OPTIONS`. */
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
};

let queue: ReturnType<typeof createQueue<ProcessingJobPayload>> | undefined;

function getQueue() {
  if (!queue) {
    queue = createQueue<ProcessingJobPayload>("enhancement");
  }
  return queue;
}

/**
 * Enqueues a processing job. `processingBullJobId` is unique per request
 * (built from the already-unique `ProcessingJob.id`), so — same as
 * generation — this is never a dedup collapse: every call gets a real,
 * running job, which is what "a merchant must be able to re-request
 * processing" requires.
 */
export async function enqueueProcessingJob(payload: ProcessingJobPayload): Promise<void> {
  await getQueue().add("process", payload, { jobId: processingBullJobId(payload), ...JOB_OPTIONS });
}
