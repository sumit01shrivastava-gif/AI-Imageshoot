/**
 * Worker process entry point.
 *
 * Run with `npm run worker` (or `npm run worker:start` for a one-shot,
 * non-watching run). Separate process from the web server — see README.md
 * in this directory.
 *
 * `"catalog-sync"` (Phase 1) is the first registered queue — see
 * services/products/sync-job.server.ts. `"generation"`/`"enhancement"`/
 * `"publishing"` remain unregistered until the phases that need them.
 */
import type { Job, Processor } from "bullmq";
import { closeRedisConnection, createWorker } from "../lib/queue";
import type { QueueName } from "../lib/queue";
import { logger } from "../lib/logging/logger.server";
import { processCatalogSyncJob } from "../services/products/sync-job.server";

interface WorkerRegistration {
  queue: QueueName;
  processor: Processor;
}

const WORKER_REGISTRY: WorkerRegistration[] = [
  { queue: "catalog-sync", processor: processCatalogSyncJob as Processor },
];

async function main(): Promise<void> {
  if (WORKER_REGISTRY.length === 0) {
    logger.info("worker.idle", {
      message: "No workers registered yet — nothing to process. See workers/README.md.",
    });
    return;
  }

  const workers = WORKER_REGISTRY.map(({ queue, processor }) =>
    createWorker(queue, processor as Processor<unknown>).on("failed", (job: Job | undefined, error: Error) => {
      logger.error("worker.job_failed", { queue, jobId: job?.id, error: error.message });
    }),
  );

  const shutdown = async (signal: string) => {
    logger.info("worker.shutdown", { signal });
    await Promise.all(workers.map((worker) => worker.close()));
    await closeRedisConnection();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
