/**
 * Queue + worker factories.
 *
 * These wrap BullMQ so that the rest of the app depends on this module,
 * not on "bullmq" directly — if we ever swap queue backends, this is the
 * only place that needs to change.
 *
 * ## Job-id dedup semantics (see docs/database.md "Catalog sync" and
 * services/products/sync-job.server.ts)
 *
 * A stable, deterministic `jobId` (e.g. `product-upsert:{shop}:{productId}`)
 * is a common, correct way to collapse duplicate *in-flight* work — BullMQ
 * treats `.add()` with a `jobId` that's still `waiting`/`active`/`delayed`
 * as a no-op, so a burst of redelivered webhooks for the same resource
 * naturally collapses onto one queued job.
 *
 * The trap: BullMQ does NOT reuse a `jobId` once the job reaches a
 * *terminal* state (`completed` or `failed`) unless that record is removed.
 * Left at BullMQ's own defaults (keep everything), a stable jobId is only
 * ever usable ONCE per queue, for the lifetime of the Redis data — every
 * later `.add()` with the same id silently returns the old, already-
 * finished job instead of enqueueing new work. (This is exactly the bug
 * fixed in `services/products/sync-job.server.ts` — see its comment for
 * the concrete failure mode.)
 *
 * The fix, applied here centrally so every queue built through
 * `createQueue` inherits it (not just `"catalog-sync"`): `removeOnComplete`
 * / `removeOnFail` default to `true`, so a job's Redis record — and with it
 * its `jobId` — is freed the moment it finishes, one way or the other. Net
 * effect, with a stable, deterministic jobId:
 *   - Two `.add()` calls for the same jobId while the first is still
 *     queued/running collapse into one job (duplicate-delivery dedup).
 *   - Once that job finishes (success OR failure), the same jobId is free
 *     again — the next legitimate event (a real subsequent change, or a
 *     merchant clicking "retry"/"sync now" again) always gets a real job.
 *   - A completed job never blocks a later legitimate one; a failed job is
 *     always retryable by the caller re-enqueueing with the same id.
 *
 * Trade-off, accepted deliberately: if a genuinely duplicate delivery
 * arrives *after* the original job has already finished, it will enqueue a
 * second job rather than being collapsed. That's fine here — every job
 * this queue runs (safe-upsert / safe-delete) is idempotent, so reprocessing
 * is at worst one extra Shopify API call, never incorrect data. Do not
 * change these defaults to retain finished jobs without also reconsidering
 * this file's jobId strategy — the two are a matched pair.
 *
 * A future queue that genuinely needs a *time-bounded* dedup window wider
 * than "while still in flight" (e.g. "collapse retries within 5 minutes
 * even after completion") should pass its own `defaultJobOptions` rather
 * than changing this default, since most queues want the behavior above.
 *
 * ## Every `Queue`/`Worker` MUST have an `'error'` listener (root cause of
 * the production worker crash-loop this pass fixes)
 *
 * BullMQ's own connection layer deliberately re-emits Redis-level
 * connection errors (a reset, a dropped socket, a reconnect) as an
 * `'error'` event on the `Queue`/`Worker` instance itself, rather than
 * swallowing them — see https://docs.bullmq.io/guide/workers#error-handling.
 * `Queue`/`Worker` extend Node's `EventEmitter`, and EventEmitter's own
 * contract is that emitting `'error'` with *zero* listeners attached
 * throws, crashing the process — see
 * https://nodejs.org/api/events.html#error-events. Neither this file nor
 * any of its callers (every domain's own `queue.server.ts`,
 * `workers/index.ts`) was attaching one, anywhere, for either the
 * producer (`Queue`) or worker (`Worker`) side.
 *
 * In production this turned an ordinary, *expected*, ioredis-recoverable
 * hiccup (a managed Redis provider — e.g. Upstash — resetting an
 * idle/long-lived connection, surfacing as `ECONNRESET` or ioredis's
 * generic `"Connection is closed."`) into a full, repeated worker-process
 * crash: Railway auto-restarts the crashed container (so the service
 * still shows "ACTIVE" at the platform level), which reconnects, runs
 * briefly, hits the same class of Redis-level event again, and crashes
 * again — the exact `connect` → `close` → `reconnecting` cycle observed
 * in production logs. The fix is centralized here (not duplicated per
 * domain) so every queue/worker this factory builds is covered
 * automatically: log the error (never throw it further — that's the
 * whole point) via the existing redacting `logger`, safe fields only
 * (queue name, error name/code/message — never Redis credentials).
 */
import { Queue, Worker, type DefaultJobOptions, type Processor, type WorkerOptions } from "bullmq";
import { getWorkerRedisConnection, getProducerRedisConnection } from "./connection.server";
import type { QueueName } from "./names";
import { logger } from "../logging/logger.server";

/** See the module doc comment's "Every Queue/Worker MUST have an
 * 'error' listener" section — attached by both `createQueue` and
 * `createWorker` below so no call site can forget it. */
function attachErrorListener(emitter: { on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown }, kind: "queue" | "worker", queueName: QueueName): void {
  emitter.on("error", (error) => {
    logger.error("bullmq.connection_error", {
      kind,
      queue: queueName,
      errorName: error.name,
      errorCode: error.code,
      errorMessage: error.message,
    });
  });
}

/** See the module doc comment above — every queue gets this unless it
 * explicitly opts out via `options.defaultJobOptions`. */
const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * BullMQ 6.1.2 long-polls an empty queue through `BZPOPMIN`. Its own
 * implementation caps that blocking call at ten seconds so it can recover a
 * broken blocking connection. Use that maximum rather than BullMQ's five
 * second default: adding a job still wakes the blocking call immediately, but
 * an idle worker performs half as many empty-queue fetch cycles.
 *
 * Keep stalled-job checks at BullMQ's default interval. They are the recovery
 * mechanism for a worker that dies while holding a job lock and must not be
 * traded away merely to reduce idle Redis traffic.
 */
export const IDLE_WORKER_DRAIN_DELAY_SECONDS = 10;

/** A queue is always a PRODUCER (`.add()`, called from an ordinary
 * request handler — Vercel serverless in this app, both the
 * Shopify-embedded routes and the standalone studio routes) — see
 * connection.server.ts's module doc comment for why this deliberately
 * uses a different connection than `createWorker` below. */
export function createQueue<PayloadType = unknown>(
  name: QueueName,
  options?: { defaultJobOptions?: DefaultJobOptions },
): Queue<PayloadType> {
  const queue = new Queue<PayloadType>(name, {
    connection: getProducerRedisConnection(),
    defaultJobOptions: options?.defaultJobOptions ?? DEFAULT_JOB_OPTIONS,
  });
  attachErrorListener(queue, "queue", name);
  return queue;
}

export function createWorker<PayloadType = unknown>(
  name: QueueName,
  processor: Processor<PayloadType>,
  options?: Omit<WorkerOptions, "connection">,
): Worker<PayloadType> {
  const worker = new Worker<PayloadType>(name, processor, {
    drainDelay: IDLE_WORKER_DRAIN_DELAY_SECONDS,
    ...options,
    connection: getWorkerRedisConnection(),
  });
  attachErrorListener(worker, "worker", name);
  return worker;
}
