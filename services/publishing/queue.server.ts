/**
 * Producer-side helper for the `"publishing"` queue — see CLAUDE.md
 * "Queue rules" (all `Queue`/`Worker` construction goes through
 * lib/queue) and lib/queue/names.ts (this queue name has been reserved
 * since Phase 0).
 */
import { createQueue } from "../../lib/queue";
import { publishingBullJobId, type PublishingJobPayload } from "./job.server";

/** Automatic retry for transient failures — same shape as every other
 * generation-adjacent queue in this codebase (generation/processing/
 * store-visuals all use `attempts: 3` + exponential backoff). A
 * permission error skips this via `UnrecoverableError` — see
 * job.server.ts. */
const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 2000 },
};

let queue: ReturnType<typeof createQueue<PublishingJobPayload>> | undefined;

function getQueue() {
  if (!queue) {
    queue = createQueue<PublishingJobPayload>("publishing");
  }
  return queue;
}

/** `publishingBullJobId` is unique per request (built from the
 * already-unique `PublishingJob.id`), so — like generation/processing/
 * store-visuals — this is never a dedup collapse; every call always gets
 * a real, running job. */
export async function enqueuePublishingJob(payload: PublishingJobPayload): Promise<void> {
  await getQueue().add("publish", payload, { jobId: publishingBullJobId(payload), ...JOB_OPTIONS });
}
