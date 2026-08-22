/**
 * Integration test for app/routes/app.products.$id.tsx's Image Processing
 * loader data + "process"/"review-processing-result"/"regenerate-processing"
 * actions — the route layer of the route → service → provider → storage →
 * persistence → UI chain (see tests/integration/processing/ for the
 * service/provider/storage/persistence layers, and tests/e2e/processing.spec.ts
 * for the full browser-driven path).
 *
 * Authenticates via the E2E test seam — see
 * tests/integration/routes/app.products.id-loader.test.ts for why
 * `ALLOW_E2E_AUTH_BYPASS`/provider env vars are set in `beforeAll`, not at
 * module load (ES module import hoisting).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { SyncedProduct } from "../../../services/products/types";
import type { ProcessingJobPayload } from "../../../services/processing/job.server";

const SHOP_A = "route-processing-a.myshopify.com";
const SHOP_B = "route-processing-b.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Studio Sofa",
    handle: "studio-sofa",
    description: "",
    productType: "Furniture",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [
      {
        shopifyMediaId: `${id}-media-1`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/sofa.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio sofa",
        position: 0,
      },
    ],
  };
}

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/products/x", {
    headers: { "x-ai-imageshoot-e2e-shop": shop },
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.creditReservation.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

let scratchDir: string;
let worker: Worker | undefined;
let loader: typeof import("../../../app/routes/app.products.$id").loader;
let action: typeof import("../../../app/routes/app.products.$id").action;

beforeAll(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "ai-imageshoot-route-processing-test-"));
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.IMAGE_PROCESSING_PROVIDER = "deterministic-test";
  process.env.STORAGE_LOCAL_ROOT = scratchDir;
  resetEnvCacheForTests();

  ({ loader, action } = await import("../../../app/routes/app.products.$id"));
  const { processProcessingJob } = await import("../../../services/processing/job.server");
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

async function callLoader(shop: string, id: string) {
  return loader({
    request: requestFor(shop),
    params: { id },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

async function callAction(shop: string, id: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/products/x", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
  return action({ request, params: { id }, context: {} } as unknown as Parameters<typeof action>[0]);
}

async function seedProduct(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  return prisma.shopifyProduct.findFirstOrThrow({
    where: { shop, shopifyProductId },
    include: { media: true },
  });
}

function waitForProcessingStatus(
  shop: string,
  productId: string,
  status: "SUCCEEDED" | "FAILED",
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callLoader(shop, productId);
      if (result.processingHistory[0]?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${result.processingHistory[0]?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.products.$id — Image Processing loader data", () => {
  it("processingHistory is empty for a product with no processing yet", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const result = await callLoader(SHOP_A, row.id);
    expect(result.processingHistory).toEqual([]);
  });
});

describe("app.products.$id — 'process' action", () => {
  it(
    "queues processing for one image, and the loader eventually reflects the completed result",
    async () => {
      const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
      const media = row.media[0];

      const actionResult = await callAction(SHOP_A, row.id, {
        intent: "process",
        sourceMediaId: media.id,
        operation: "REMOVE_BACKGROUND",
      });
      expect(actionResult).toEqual({ ok: true });

      await waitForProcessingStatus(SHOP_A, row.id, "SUCCEEDED");

      const result = await callLoader(SHOP_A, row.id);
      expect(result.processingHistory).toHaveLength(1);
      expect(result.processingHistory[0].status).toBe("SUCCEEDED");
      expect(result.processingHistory[0].results.length).toBeGreaterThan(0);
      expect(result.processingHistory[0].sourceMedia.originalUrl).toBe("https://cdn.shopify.com/sofa.jpg");

      // Original preservation: Shopify's own media row untouched.
      const mediaRow = await prisma.shopifyProductMedia.findUniqueOrThrow({ where: { id: media.id } });
      expect(mediaRow.originalUrl).toBe("https://cdn.shopify.com/sofa.jpg");
    },
    15000,
  );

  it("returns a safe error for a source media id that doesn't belong to this product", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");

    const result = await callAction(SHOP_A, row.id, {
      intent: "process",
      sourceMediaId: "not-a-real-media-id",
      operation: "REMOVE_BACKGROUND",
    });
    expect(result).toEqual({
      ok: false,
      error: "The selected image could not be found for this product.",
    });
  });

  it("throws a safe 404 — not a raw TenantMismatchError — for a product belonging to another shop", async () => {
    const otherRow = await seedProduct(SHOP_B, "gid://shopify/Product/1");

    let caught: unknown;
    try {
      await callAction(SHOP_A, otherRow.id, {
        intent: "process",
        sourceMediaId: otherRow.media[0].id,
        operation: "REMOVE_BACKGROUND",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
    expect(await (caught as Response).text()).toBe("Product not found");
  });
});

describe("app.products.$id — 'review-processing-result' action", () => {
  it(
    "approves a result, identifying the exact result id",
    async () => {
      const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
      await callAction(SHOP_A, row.id, {
        intent: "process",
        sourceMediaId: row.media[0].id,
        operation: "REMOVE_BACKGROUND",
      });
      await waitForProcessingStatus(SHOP_A, row.id, "SUCCEEDED");
      const before = await callLoader(SHOP_A, row.id);
      const resultId = before.processingHistory[0].results[0].id;

      const actionResult = await callAction(SHOP_A, row.id, {
        intent: "review-processing-result",
        resultId,
        decision: "APPROVED",
      });
      expect(actionResult).toEqual({ ok: true });

      const after = await callLoader(SHOP_A, row.id);
      expect(after.processingHistory[0].results[0].id).toBe(resultId);
      expect(after.processingHistory[0].results[0].reviewStatus).toBe("APPROVED");
    },
    15000,
  );

  it("throws a safe 404 when reviewing a result belonging to another shop", async () => {
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/1");
    await callAction(SHOP_B, rowB.id, {
      intent: "process",
      sourceMediaId: rowB.media[0].id,
      operation: "REMOVE_BACKGROUND",
    });
    await waitForProcessingStatus(SHOP_B, rowB.id, "SUCCEEDED", 8000);
    const batchLoad = await callLoader(SHOP_B, rowB.id);
    const resultId = batchLoad.processingHistory[0].results[0].id;

    let caught: unknown;
    try {
      await callAction(SHOP_A, rowB.id, { intent: "review-processing-result", resultId, decision: "APPROVED" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });
});

describe("app.products.$id — 'regenerate-processing' action", () => {
  it(
    "creates a new, independent job — the previous result remains in history untouched",
    async () => {
      const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
      await callAction(SHOP_A, row.id, {
        intent: "process",
        sourceMediaId: row.media[0].id,
        operation: "ENHANCE",
      });
      await waitForProcessingStatus(SHOP_A, row.id, "SUCCEEDED");
      const before = await callLoader(SHOP_A, row.id);
      const originalJobId = before.processingHistory[0].id;
      const originalResultId = before.processingHistory[0].results[0].id;

      const actionResult = await callAction(SHOP_A, row.id, {
        intent: "regenerate-processing",
        jobId: originalJobId,
      });
      expect(actionResult).toEqual({ ok: true });

      await waitForProcessingStatus(SHOP_A, row.id, "SUCCEEDED");
      const after = await callLoader(SHOP_A, row.id);

      expect(after.processingHistory).toHaveLength(2);
      const originalStill = after.processingHistory.find((job) => job.id === originalJobId);
      expect(originalStill?.results).toHaveLength(1);
      expect(originalStill?.results[0].id).toBe(originalResultId); // untouched
      expect(after.processingHistory[0].id).not.toBe(originalJobId); // newest first
    },
    20000,
  );

  it("throws a safe 404 for a job id belonging to another shop", async () => {
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/1");
    await callAction(SHOP_B, rowB.id, {
      intent: "process",
      sourceMediaId: rowB.media[0].id,
      operation: "REMOVE_BACKGROUND",
    });
    await waitForProcessingStatus(SHOP_B, rowB.id, "SUCCEEDED", 8000);
    const jobId = (await callLoader(SHOP_B, rowB.id)).processingHistory[0].id;

    let caught: unknown;
    try {
      await callAction(SHOP_A, rowB.id, { intent: "regenerate-processing", jobId });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });
});
