/**
 * Integration test: batch processing end to end — Phase 1's
 * `ImageSelection` → `startBatchProcessing` → real BullMQ enqueue → real
 * `processProcessingJob` worker (deterministic provider) → real storage
 * → `getBatchSummary`'s computed progress. Against real local
 * Postgres/Redis and a scratch temp storage directory.
 *
 * Covers: multiple products in one batch, progress tracking, a batch
 * finishing all-succeeded, and a batch finishing partially-succeeded
 * (one job fails DURING processing without blocking the others' progress
 * — see the section-7/12 requirement "one failed product must not
 * prevent other products from completing"). Job-CREATION-time skip
 * (services/processing/batch.server.ts's try/catch around
 * `createAndEnqueueProcessingJob`) is not separately exercised here: the
 * only realistic trigger is a genuine race (a product/media deleted
 * between the selection being read and that specific item's job being
 * created), which isn't reproducible without mocking internals — the
 * try/catch itself, plus this file's coverage of "one job's terminal
 * FAILURE doesn't affect the batch's other jobs", is what's tested.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { createImageSelection } from "../../../services/products/selection.server";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { ProcessingJobPayload } from "../../../services/processing/job.server";
import { FORCE_FAILURE_ALWAYS } from "../../../services/processing/deterministic-test-provider.server";

const SHOP = "batch-e2e-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string, altText: string | null = null): SyncedProduct {
  return {
    shopifyProductId,
    title: `Product ${shopifyProductId}`,
    handle: shopifyProductId,
    description: "",
    productType: "",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [
      {
        shopifyMediaId: `${shopifyProductId}-media`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/x.jpg",
        previewUrl: null,
        width: 100,
        height: 100,
        altText,
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.processingBatch.deleteMany({ where: { shop: SHOP } });
}

let scratchDir: string;
let worker: Worker | undefined;
let startBatchProcessing: typeof import("../../../services/processing/batch.server").startBatchProcessing;
let getBatchSummary: typeof import("../../../services/processing/batch.server").getBatchSummary;
let processProcessingJob: typeof import("../../../services/processing/job.server").processProcessingJob;

beforeAll(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "ai-imageshoot-batch-test-"));
  process.env.IMAGE_PROCESSING_PROVIDER = "deterministic-test";
  process.env.STORAGE_LOCAL_ROOT = scratchDir;
  resetEnvCacheForTests();

  ({ startBatchProcessing, getBatchSummary } = await import("../../../services/processing/batch.server"));
  ({ processProcessingJob } = await import("../../../services/processing/job.server"));

  worker = createWorker<ProcessingJobPayload>("enhancement", processProcessingJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();
});

afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});

afterAll(async () => {
  await cleanup();
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  await rm(scratchDir, { recursive: true, force: true });
  delete process.env.IMAGE_PROCESSING_PROVIDER;
  delete process.env.STORAGE_LOCAL_ROOT;
  resetEnvCacheForTests();
});

async function seedProducts(specs: Array<{ id: string; altText?: string | null }>) {
  const rows = [];
  for (const spec of specs) {
    await upsertSyncedProduct(SHOP, product(spec.id, spec.altText ?? null));
    rows.push(
      await prisma.shopifyProduct.findFirstOrThrow({
        where: { shop: SHOP, shopifyProductId: spec.id },
        include: { media: true },
      }),
    );
  }
  return rows;
}

function waitForTerminal(batchId: string, expectedTotal: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<Awaited<ReturnType<typeof getBatchSummary>>>((resolve, reject) => {
    const poll = async () => {
      const summary = await getBatchSummary(CONTEXT, batchId);
      const { progress } = summary!;
      const inFlight = progress.pending + progress.queued + progress.processing;
      if (progress.total >= expectedTotal && inFlight === 0) {
        resolve(summary);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; progress=${JSON.stringify(progress)}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("batch processing: end-to-end", () => {
  it(
    "creates one independent job per selected image and finishes ALL SUCCEEDED",
    async () => {
      const [p1, p2, p3] = await seedProducts([
        { id: "gid://shopify/Product/1" },
        { id: "gid://shopify/Product/2" },
        { id: "gid://shopify/Product/3" },
      ]);
      const selectionId = await createImageSelection(CONTEXT, [
        { productId: p1.id, productMediaId: p1.media[0].id },
        { productId: p2.id, productMediaId: p2.media[0].id },
        { productId: p3.id, productMediaId: p3.media[0].id },
      ]);

      const { batchId, jobCount } = await startBatchProcessing(CONTEXT, {
        selectionId,
        operation: "REMOVE_BACKGROUND",
      });
      expect(jobCount).toBe(3);

      const summary = await waitForTerminal(batchId, 3, 15000);
      expect(summary!.progress.total).toBe(3);
      expect(summary!.progress.succeeded).toBe(3);
      expect(summary!.progress.failed).toBe(0);
      expect(summary!.jobs).toHaveLength(3);
      expect(summary!.jobs.every((job) => job.results.length === 1)).toBe(true);
    },
    20000,
  );

  it(
    "one job failing during processing does not block the others — batch finishes PARTIALLY SUCCEEDED",
    async () => {
      const [ok1, failing, ok2] = await seedProducts([
        { id: "gid://shopify/Product/10" },
        { id: "gid://shopify/Product/11", altText: FORCE_FAILURE_ALWAYS },
        { id: "gid://shopify/Product/12" },
      ]);
      const selectionId = await createImageSelection(CONTEXT, [
        { productId: ok1.id, productMediaId: ok1.media[0].id },
        { productId: failing.id, productMediaId: failing.media[0].id },
        { productId: ok2.id, productMediaId: ok2.media[0].id },
      ]);

      const { batchId, jobCount } = await startBatchProcessing(CONTEXT, {
        selectionId,
        operation: "REMOVE_BACKGROUND",
      });
      expect(jobCount).toBe(3);

      const summary = await waitForTerminal(batchId, 3, 25000);
      expect(summary!.progress.total).toBe(3);
      expect(summary!.progress.succeeded).toBe(2);
      expect(summary!.progress.failed).toBe(1);

      const failedJob = summary!.jobs.find((job) => job.status === "FAILED");
      expect(failedJob?.errorMessage).toBe("Processing failed. Please try again in a moment.");
      const succeededJobs = summary!.jobs.filter((job) => job.status === "SUCCEEDED");
      expect(succeededJobs).toHaveLength(2);
    },
    30000,
  );

  it("throws SelectionNotFoundError for a selection that doesn't exist", async () => {
    const { SelectionNotFoundError } = await import("../../../services/processing/batch.server");
    await expect(
      startBatchProcessing(CONTEXT, { selectionId: "does-not-exist", operation: "REMOVE_BACKGROUND" }),
    ).rejects.toThrow(SelectionNotFoundError);
  });

  it("getBatchSummary throws TenantMismatchError for a batch belonging to another shop", async () => {
    const otherShop = `${SHOP}-other`;
    const otherContext: AuthContext = { shop: otherShop, sessionId: "s2", isOnline: false };
    const [p1] = await seedProducts([{ id: "gid://shopify/Product/20" }]);
    const selectionId = await createImageSelection(CONTEXT, [{ productId: p1.id, productMediaId: p1.media[0].id }]);
    const { batchId } = await startBatchProcessing(CONTEXT, { selectionId, operation: "REMOVE_BACKGROUND" });

    const { TenantMismatchError } = await import("../../../lib/auth/tenant.server");
    await expect(getBatchSummary(otherContext, batchId)).rejects.toThrow(TenantMismatchError);

    await prisma.shopifyProduct.deleteMany({ where: { shop: otherShop } });
  });
});
