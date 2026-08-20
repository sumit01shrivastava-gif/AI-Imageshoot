/**
 * Integration test: the `"enhancement"` queue, end to end —
 * `requestProcessing` (the real service entry point) → real BullMQ
 * enqueue → real `processProcessingJob` worker → real deterministic
 * provider (services/processing/deterministic-test-provider.server.ts) →
 * result validation → real filesystem storage upload
 * (lib/storage/local-filesystem-provider.server.ts) → real persistence.
 * Against real local Postgres/Redis (docker-compose) and a scratch temp
 * directory for storage.
 *
 * Deliberately NOT a test that mocks the provider, storage, or the queue
 * — mirrors tests/integration/generation/generation-queue.test.ts, which
 * established this pattern for Phase 3.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { ProcessingJobPayload } from "../../../services/processing/job.server";
import {
  FORCE_FAILURE_ALWAYS,
  FORCE_FAILURE_ONCE,
} from "../../../services/processing/deterministic-test-provider.server";

const SHOP = "proc-queue-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };
const ORIGINAL_URL = "https://cdn.shopify.com/handbag.jpg";

function product(shopifyProductId: string, altText: string | null = null): SyncedProduct {
  return {
    shopifyProductId,
    title: "Red Leather Handbag",
    handle: "red-leather-handbag",
    description: "",
    productType: "Handbags",
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
        originalUrl: ORIGINAL_URL,
        previewUrl: null,
        width: 800,
        height: 600,
        altText,
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
}

let scratchDir: string;
let worker: Worker | undefined;
// Imported inside beforeAll, after the env seam is set up — ES module
// imports are hoisted ahead of this file's own statements, and some of
// these transitively call getEnv() at their own top level (see
// tests/integration/generation/generation-queue.test.ts for the same
// reasoning).
let requestProcessing: typeof import("../../../services/processing/request-processing.server").requestProcessing;
let getProcessing: typeof import("../../../services/processing/request-processing.server").getProcessing;
let processProcessingJob: typeof import("../../../services/processing/job.server").processProcessingJob;

beforeAll(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "ai-imageshoot-processing-queue-test-"));
  process.env.IMAGE_PROCESSING_PROVIDER = "deterministic-test";
  process.env.STORAGE_LOCAL_ROOT = scratchDir;
  resetEnvCacheForTests();

  ({ requestProcessing, getProcessing } = await import("../../../services/processing/request-processing.server"));
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

async function seedProduct(shopifyProductId: string, altText: string | null = null) {
  await upsertSyncedProduct(SHOP, product(shopifyProductId, altText));
  return prisma.shopifyProduct.findFirstOrThrow({
    where: { shop: SHOP, shopifyProductId },
    include: { media: true },
  });
}

function waitForStatus(jobId: string, status: "SUCCEEDED" | "FAILED", timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const job = await getProcessing(CONTEXT, jobId);
      if (job?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for status ${status}; last saw ${job?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("processing queue: end-to-end", () => {
  it(
    "processes a real product through the real queue, provider seam, storage upload, and persistence — original untouched",
    async () => {
      const row = await seedProduct("gid://shopify/Product/1");
      const media = row.media[0];

      const job = await requestProcessing(CONTEXT, {
        productId: row.id,
        sourceMediaId: media.id,
        operation: "REMOVE_BACKGROUND",
      });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getProcessing(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.providerName).toBe("deterministic-test");
      expect(result?.results).toHaveLength(1);

      const [output] = result!.results;
      expect(output.storageKey).toContain(SHOP);
      expect(output.format).toBe("png");

      // Prove this is a REAL stored object, not just a DB row.
      const stored = await getConfiguredStorageProvider().download(output.storageKey);
      expect(stored.contentType).toBe("image/png");
      expect(stored.body.byteLength).toBeGreaterThan(0);

      // Original preservation: Shopify's own media reference is
      // completely untouched by processing.
      const mediaRow = await prisma.shopifyProductMedia.findUniqueOrThrow({ where: { id: media.id } });
      expect(mediaRow.originalUrl).toBe(ORIGINAL_URL);
    },
    15000,
  );

  it(
    "enhance and resize operations also succeed through the real pipeline",
    async () => {
      const row = await seedProduct("gid://shopify/Product/1");
      const media = row.media[0];

      const enhanceJob = await requestProcessing(CONTEXT, {
        productId: row.id,
        sourceMediaId: media.id,
        operation: "ENHANCE",
      });
      await waitForStatus(enhanceJob.id, "SUCCEEDED", 8000);
      expect((await getProcessing(CONTEXT, enhanceJob.id))?.results).toHaveLength(1);

      const resizeJob = await requestProcessing(CONTEXT, {
        productId: row.id,
        sourceMediaId: media.id,
        operation: "RESIZE",
        options: { aspectRatio: "4:5" },
      });
      await waitForStatus(resizeJob.id, "SUCCEEDED", 8000);
      const resized = await getProcessing(CONTEXT, resizeJob.id);
      expect(resized?.results).toHaveLength(1);
      expect(resized?.options).toEqual({ aspectRatio: "4:5" });
    },
    20000,
  );

  it(
    "a provider failure surfaces as FAILED with a merchant-safe message (never a raw provider error)",
    async () => {
      const row = await seedProduct("gid://shopify/Product/1", FORCE_FAILURE_ALWAYS);
      const media = row.media[0];

      const job = await requestProcessing(CONTEXT, {
        productId: row.id,
        sourceMediaId: media.id,
        operation: "REMOVE_BACKGROUND",
      });
      await waitForStatus(job.id, "FAILED", 20000);

      const result = await getProcessing(CONTEXT, job.id);
      expect(result?.status).toBe("FAILED");
      expect(result?.errorMessage).toBe("Processing failed. Please try again in a moment.");
      expect(result?.errorMessage).not.toContain("deterministic-test processing provider");
      expect(result?.results).toHaveLength(0);
    },
    25000,
  );

  it(
    "retries automatically on a transient provider failure and eventually succeeds",
    async () => {
      const row = await seedProduct("gid://shopify/Product/1", FORCE_FAILURE_ONCE);
      const media = row.media[0];

      const job = await requestProcessing(CONTEXT, {
        productId: row.id,
        sourceMediaId: media.id,
        operation: "REMOVE_BACKGROUND",
      });
      await waitForStatus(job.id, "SUCCEEDED", 15000);

      const result = await getProcessing(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.retryCount).toBeGreaterThanOrEqual(1);
    },
    20000,
  );

  it(
    "regeneration creates a NEW, independent job — the previous result is preserved untouched",
    async () => {
      const row = await seedProduct("gid://shopify/Product/1");
      const media = row.media[0];

      const first = await requestProcessing(CONTEXT, {
        productId: row.id,
        sourceMediaId: media.id,
        operation: "REMOVE_BACKGROUND",
      });
      await waitForStatus(first.id, "SUCCEEDED", 8000);
      const firstResult = (await getProcessing(CONTEXT, first.id))!;
      const firstStorageKey = firstResult.results[0].storageKey;

      const second = await requestProcessing(CONTEXT, {
        productId: row.id,
        sourceMediaId: media.id,
        operation: "REMOVE_BACKGROUND",
      });
      expect(second.id).not.toBe(first.id);
      await waitForStatus(second.id, "SUCCEEDED", 8000);

      // Previous job/result completely unchanged.
      const firstAfter = await getProcessing(CONTEXT, first.id);
      expect(firstAfter?.status).toBe("SUCCEEDED");
      expect(firstAfter?.results).toHaveLength(1);
      expect(firstAfter?.results[0].storageKey).toBe(firstStorageKey);

      // Its stored bytes still exist too — regenerate never deletes.
      const stillStored = await getConfiguredStorageProvider().download(firstStorageKey);
      expect(stillStored.body.byteLength).toBeGreaterThan(0);
    },
    20000,
  );

  it("throws for a product id that doesn't belong to this shop (never trusts a client-supplied id)", async () => {
    const otherShop = `${SHOP}-other`;
    await upsertSyncedProduct(otherShop, product("gid://shopify/Product/1"));
    const otherRow = await prisma.shopifyProduct.findFirstOrThrow({
      where: { shop: otherShop },
      include: { media: true },
    });

    const { ProductNotFoundError } = await import("../../../services/processing/request-processing.server");
    await expect(
      requestProcessing(CONTEXT, { productId: otherRow.id, sourceMediaId: otherRow.media[0].id, operation: "REMOVE_BACKGROUND" }),
    ).rejects.toThrow(ProductNotFoundError);

    await prisma.shopifyProduct.deleteMany({ where: { shop: otherShop } });
  });
});
