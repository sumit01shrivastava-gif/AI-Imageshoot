/**
 * Worker process entry point.
 *
 * Run with `npm run worker` (or `npm run worker:start` for a one-shot,
 * non-watching run). Separate process from the web server — see README.md
 * in this directory.
 *
 * `"catalog-sync"` (Phase 1), `"product-intelligence"` (Phase 2),
 * `"generation"` (Phase 3), `"enhancement"` (Phase 4),
 * `"store-visuals"` (Package 3, store-level generation), and
 * `"publishing"` (production hardening pass) are all registered — see
 * services/products/sync-job.server.ts,
 * services/intelligence/job.server.ts, services/generation/job.server.ts,
 * services/processing/job.server.ts, services/store-visuals/job.server.ts,
 * and services/publishing/job.server.ts.
 */
import type { Job, Processor } from "bullmq";
import { closeRedisConnection, createWorker } from "../lib/queue";
import type { QueueName } from "../lib/queue";
import { logger } from "../lib/logging/logger.server";
import { processCatalogSyncJob } from "../services/products/sync-job.server";
import { processProductIntelligenceJob } from "../services/intelligence/job.server";
import { processGenerationJob } from "../services/generation/job.server";
import { processProcessingJob } from "../services/processing/job.server";
import { processStoreVisualJob } from "../services/store-visuals/job.server";
import { processPublishingJob } from "../services/publishing/job.server";

interface WorkerRegistration {
  queue: QueueName;
  processor: Processor;
}

const WORKER_REGISTRY: WorkerRegistration[] = [
  { queue: "catalog-sync", processor: processCatalogSyncJob as Processor },
  { queue: "product-intelligence", processor: processProductIntelligenceJob as Processor },
  { queue: "generation", processor: processGenerationJob as Processor },
  { queue: "enhancement", processor: processProcessingJob as Processor },
  { queue: "store-visuals", processor: processStoreVisualJob as Processor },
  { queue: "publishing", processor: processPublishingJob as Processor },
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
