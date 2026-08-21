/**
 * Integration test for app/routes/app.generation.$batchId.tsx's loader
 * (batch summary) and action (review approve/reject, regenerate) — the
 * route layer of the route → service → provider → storage → persistence
 * → UI chain (see tests/integration/generation/batch-generation.test.ts
 * for the service/provider/storage/persistence layers). Mirrors
 * app.processing.batch-action.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { SyncedProduct } from "../../../services/products/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP_A = "route-gen-batch-a.myshopify.com";
const SHOP_B = "route-gen-batch-b.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Leather Tote",
    handle: "leather-tote",
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
        shopifyMediaId: `${id}-media-1`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/tote.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Leather tote",
        position: 0,
      },
    ],
  };
}

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/generation/x", {
    headers: { "x-ai-imageshoot-e2e-shop": shop },
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.generationBatch.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.creditReservation.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

let worker: Worker | undefined;
let loader: typeof import("../../../app/routes/app.generation.$batchId").loader;
let action: typeof import("../../../app/routes/app.generation.$batchId").action;
let startBatchGeneration: typeof import("../../../services/generation/batch.server").startBatchGeneration;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ loader, action } = await import("../../../app/routes/app.generation.$batchId"));
  ({ startBatchGeneration } = await import("../../../services/generation/batch.server"));
  const { processGenerationJob } = await import("../../../services/generation/job.server");
  worker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
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
  delete process.env.AI_PROVIDER;
  resetEnvCacheForTests();
});

async function callLoader(shop: string, batchId: string) {
  return loader({
    request: requestFor(shop),
    params: { batchId },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

async function callAction(shop: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/generation/x", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
  return action({ request, params: {}, context: {} } as unknown as Parameters<typeof action>[0]);
}

async function seedAndStartBatch(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({
    where: { shop, shopifyProductId },
    include: { media: true },
  });
  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["lifestyle"],
    identityAnchors: { category: "Handbags", material: "Leather" },
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });

  const { createImageSelection } = await import("../../../services/products/selection.server");
  const context = { shop, sessionId: "s", isOnline: false };
  const selectionId = await createImageSelection(context, [
    { productId: row.id, productMediaId: row.media[0].id },
  ]);
  const { batchId } = await startBatchGeneration(context, { selectionId, generationType: "LIFESTYLE" });
  return { row, batchId };
}

function waitForBatchTerminal(shop: string, batchId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callLoader(shop, batchId);
      const { progress } = result.summary;
      if (progress.pending + progress.queued + progress.processing === 0 && progress.total > 0) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("Timed out waiting for batch to finish"));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.generation.$batchId — loader", () => {
  it("returns the batch summary with progress and jobs for the owning shop", async () => {
    const { batchId } = await seedAndStartBatch(SHOP_A, "gid://shopify/Product/1");
    await waitForBatchTerminal(SHOP_A, batchId);

    const result = await callLoader(SHOP_A, batchId);
    expect(result.summary.generationType).toBe("LIFESTYLE");
    expect(result.summary.progress.total).toBe(1);
    expect(result.summary.progress.succeeded).toBe(1);
    expect(result.summary.jobs).toHaveLength(1);
    expect(result.summary.jobs[0].results).toHaveLength(1);
  });

  it("throws a safe 404 for a batch belonging to another shop", async () => {
    const { batchId } = await seedAndStartBatch(SHOP_B, "gid://shopify/Product/1");

    let caught: unknown;
    try {
      await callLoader(SHOP_A, batchId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });
});

describe("app.generation.$batchId — 'review' action", () => {
  it("approves a result, identifying the exact result id", async () => {
    const { batchId } = await seedAndStartBatch(SHOP_A, "gid://shopify/Product/1");
    await waitForBatchTerminal(SHOP_A, batchId);
    const before = await callLoader(SHOP_A, batchId);
    const resultId = before.summary.jobs[0].results[0].id;

    const actionResult = await callAction(SHOP_A, { intent: "review", resultId, decision: "APPROVED" });
    expect(actionResult).toEqual({ ok: true });

    const after = await callLoader(SHOP_A, batchId);
    expect(after.summary.jobs[0].results[0].reviewStatus).toBe("APPROVED");
  });

  it("throws a safe 404 when reviewing a result belonging to another shop", async () => {
    const { batchId } = await seedAndStartBatch(SHOP_B, "gid://shopify/Product/3");
    await waitForBatchTerminal(SHOP_B, batchId);
    const otherBatch = await callLoader(SHOP_B, batchId);
    const resultId = otherBatch.summary.jobs[0].results[0].id;

    let caught: unknown;
    try {
      await callAction(SHOP_A, { intent: "review", resultId, decision: "APPROVED" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });
});

describe("app.generation.$batchId — 'regenerate' action", () => {
  it("creates a new job in the same batch — the previous result remains unchanged", async () => {
    const { batchId } = await seedAndStartBatch(SHOP_A, "gid://shopify/Product/4");
    await waitForBatchTerminal(SHOP_A, batchId);
    const before = await callLoader(SHOP_A, batchId);
    const originalJobId = before.summary.jobs[0].id;
    const originalResultId = before.summary.jobs[0].results[0].id;

    const actionResult = await callAction(SHOP_A, { intent: "regenerate", jobId: originalJobId });
    expect(actionResult).toEqual({ ok: true });

    await waitForBatchTerminal(SHOP_A, batchId, 8000);
    const after = await callLoader(SHOP_A, batchId);

    expect(after.summary.jobs).toHaveLength(2); // the new job joined the same batch
    const originalStill = after.summary.jobs.find((job) => job.id === originalJobId);
    expect(originalStill?.results).toHaveLength(1);
    expect(originalStill?.results[0].id).toBe(originalResultId); // untouched
  });
});
