/**
 * Queue + worker factories.
 *
 * These wrap BullMQ so that the rest of the app depends on this module,
 * not on "bullmq" directly — if we ever swap queue backends, this is the
 * only place that needs to change.
 *
 * No processors are registered anywhere yet; see workers/README.md.
 */
import { Queue, Worker, type Processor, type WorkerOptions } from "bullmq";
import { getRedisConnection } from "./connection.server";
import type { QueueName } from "./names";

export function createQueue<PayloadType = unknown>(name: QueueName): Queue<PayloadType> {
  return new Queue<PayloadType>(name, { connection: getRedisConnection() });
}

export function createWorker<PayloadType = unknown>(
  name: QueueName,
  processor: Processor<PayloadType>,
  options?: Omit<WorkerOptions, "connection">,
): Worker<PayloadType> {
  return new Worker<PayloadType>(name, processor, {
    ...options,
    connection: getRedisConnection(),
  });
}
