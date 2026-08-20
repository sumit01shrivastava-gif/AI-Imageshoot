/**
 * Integration tests for the `"catalog-sync"` queue's job-id/dedup
 * semantics — see lib/queue/queue.server.ts's module doc comment for the
 * full reasoning this test suite verifies.
 *
 * These run against the real local Redis (docker-compose — see
 * tests/setup.ts) through the actual production code paths:
 * `enqueueCatalogSync` (the real producer) and `createWorker` (the real
 * worker factory), exactly as `workers/index.ts` uses them. A test that
 * only called `runCatalogSync`/`syncSingleProduct` directly — bypassing
 * BullMQ entirely — would NOT have caught the original bug (deterministic
 * jobIds silently blocking all future enqueues once a job reached a
 * terminal state); this suite deliberately exercises the queue itself.
 *
 * The worker here uses a small controllable test processor (records what
 * it processed, can be told to fail) rather than the real
 * `processCatalogSyncJob` — the original bug lived entirely in
 * `lib/queue/queue.server.ts`'s queue construction, not in
 * `processCatalogSyncJob`'s business logic (which already has its own
 * coverage in tests/integration/products/sync.test.ts), so testing at
 * this layer is the precise, minimal place to catch a regression.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Job, Worker } from "bullmq";
import { createQueue, createWorker, closeRedisConnection } from "../../../lib/queue";
import { enqueueCatalogSync } from "../../../services/products/sync-queue.server";
import { catalogSyncJobId, type CatalogSyncJobPayload } from "../../../services/products/sync-job.server";

const queue = createQueue<CatalogSyncJobPayload>("catalog-sync");

let processed: CatalogSyncJobPayload[] = [];
let shouldFail: (payload: CatalogSyncJobPayload) => boolean = () => false;

const worker: Worker<CatalogSyncJobPayload> = createWorker<CatalogSyncJobPayload>(
  "catalog-sync",
  async (job) => {
    processed.push(job.data);
    if (shouldFail(job.data)) {
      throw new Error("simulated failure");
    }
  },
);

function waitForOutcome(jobId: string, timeoutMs = 8000): Promise<"completed" | "failed"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for job "${jobId}" to finish.`));
    }, timeoutMs);

    const onCompleted = (job: Job) => {
      if (job.id === jobId) {
        cleanup();
        resolve("completed");
      }
    };
    const onFailed = (job: Job | undefined) => {
      if (job?.id === jobId) {
        cleanup();
        resolve("failed");
      }
    };
    function cleanup() {
      clearTimeout(timer);
      worker.off("completed", onCompleted);
      worker.off("failed", onFailed);
    }

    worker.on("completed", onCompleted);
    worker.on("failed", onFailed);
  });
}

function uniqueShop(label: string): string {
  return `audit-fix1-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.myshopify.com`;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => worker.on("ready", () => resolve()));
});

afterEach(() => {
  processed = [];
  shouldFail = () => false;
});

afterAll(async () => {
  await worker.close();
  await queue.close();
  await closeRedisConnection();
});

describe("catalog-sync queue: job-id reuse semantics", () => {
  it("A: the first sync for a shop runs", async () => {
    const payload: CatalogSyncJobPayload = { type: "full-sync", shop: uniqueShop("a"), mode: "full" };

    await enqueueCatalogSync(payload);
    const outcome = await waitForOutcome(catalogSyncJobId(payload));

    expect(outcome).toBe("completed");
    expect(processed).toEqual([payload]);
  });

  it("B: a second manual sync, requested after the first completes, also runs (regression: previously a silent no-op)", async () => {
    const payload: CatalogSyncJobPayload = { type: "full-sync", shop: uniqueShop("b"), mode: "full" };

    await enqueueCatalogSync(payload);
    await waitForOutcome(catalogSyncJobId(payload));
    processed = [];

    await enqueueCatalogSync(payload);
    const secondOutcome = await waitForOutcome(catalogSyncJobId(payload));

    expect(secondOutcome).toBe("completed");
    expect(processed).toEqual([payload]);
  });

  it("C: a failed sync can be retried by enqueueing again (regression: previously stuck forever)", async () => {
    const payload: CatalogSyncJobPayload = { type: "full-sync", shop: uniqueShop("c"), mode: "full" };

    shouldFail = () => true;
    await enqueueCatalogSync(payload);
    const firstOutcome = await waitForOutcome(catalogSyncJobId(payload));
    expect(firstOutcome).toBe("failed");

    shouldFail = () => false;
    processed = [];
    await enqueueCatalogSync(payload);
    const retryOutcome = await waitForOutcome(catalogSyncJobId(payload));

    expect(retryOutcome).toBe("completed");
    expect(processed).toEqual([payload]);
  });

  it("D: two webhook deliveries that arrive while the first is still queued collapse onto one job", async () => {
    const payload: CatalogSyncJobPayload = {
      type: "product-upsert",
      shop: uniqueShop("d"),
      shopifyProductId: "gid://shopify/Product/1",
    };
    const jobId = catalogSyncJobId(payload);

    // Pause the worker so both "deliveries" land while the job is still
    // waiting — simulating Shopify redelivering the same webhook before
    // the first delivery has been processed.
    await worker.pause();
    await enqueueCatalogSync(payload);
    await enqueueCatalogSync(payload); // the "duplicate delivery"

    const waiting = await queue.getJobCounts("waiting");
    expect(waiting.waiting).toBe(1); // not 2 — the duplicate collapsed

    await worker.resume();
    const outcome = await waitForOutcome(jobId);

    expect(outcome).toBe("completed");
    expect(processed).toEqual([payload]); // processed exactly once, not twice
  });

  it("E: a later, genuinely new update for the same product still runs after the first completes", async () => {
    const shop = uniqueShop("e");
    const payload: CatalogSyncJobPayload = {
      type: "product-upsert",
      shop,
      shopifyProductId: "gid://shopify/Product/1",
    };

    await enqueueCatalogSync(payload);
    await waitForOutcome(catalogSyncJobId(payload));
    processed = [];

    // Same shop + same product id — exactly the shape of "the merchant
    // edited this product again later" (a second products/update webhook).
    await enqueueCatalogSync(payload);
    const secondOutcome = await waitForOutcome(catalogSyncJobId(payload));

    expect(secondOutcome).toBe("completed");
    expect(processed).toEqual([payload]);
  });

  it("F: two different products for the same shop are processed independently", async () => {
    const shop = uniqueShop("f");
    const payloadA: CatalogSyncJobPayload = { type: "product-upsert", shop, shopifyProductId: "gid://shopify/Product/A" };
    const payloadB: CatalogSyncJobPayload = { type: "product-upsert", shop, shopifyProductId: "gid://shopify/Product/B" };

    await Promise.all([enqueueCatalogSync(payloadA), enqueueCatalogSync(payloadB)]);
    await Promise.all([
      waitForOutcome(catalogSyncJobId(payloadA)),
      waitForOutcome(catalogSyncJobId(payloadB)),
    ]);

    expect(processed).toHaveLength(2);
    expect(processed).toEqual(expect.arrayContaining([payloadA, payloadB]));
  });

  it("G: the same product id for two different shops is processed independently", async () => {
    const productId = "gid://shopify/Product/shared-numeric-id";
    const payloadShop1: CatalogSyncJobPayload = {
      type: "product-upsert",
      shop: uniqueShop("g1"),
      shopifyProductId: productId,
    };
    const payloadShop2: CatalogSyncJobPayload = {
      type: "product-upsert",
      shop: uniqueShop("g2"),
      shopifyProductId: productId,
    };

    await Promise.all([enqueueCatalogSync(payloadShop1), enqueueCatalogSync(payloadShop2)]);
    await Promise.all([
      waitForOutcome(catalogSyncJobId(payloadShop1)),
      waitForOutcome(catalogSyncJobId(payloadShop2)),
    ]);

    expect(processed).toHaveLength(2);
    expect(processed).toEqual(expect.arrayContaining([payloadShop1, payloadShop2]));
  });
});
