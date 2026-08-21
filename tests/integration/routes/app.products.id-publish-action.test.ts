/**
 * Integration test for app/routes/app.products.$id.tsx's
 * "request-publish" action — the route layer over
 * services/publishing/request-publish.server.ts. Doesn't run a
 * "publishing" worker (that pipeline, including the mocked Shopify
 * boundary, is covered by tests/integration/publishing/publishing-queue.test.ts)
 * — this file only proves the route wires the action through correctly:
 * validation errors surface as merchant-safe messages, and a valid
 * request creates a real, QUEUED PublishingJob row.
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

const SHOP_A = "route-publish-a.myshopify.com";
const SHOP_B = "route-publish-b.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Studio Sofa",
    handle: "studio-sofa",
    description: "A minimalist sofa.",
    productType: "Furniture",
    category: "Home & Garden > Furniture",
    vendor: "Acme Home",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
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

async function seedAnalyzed(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
  const data = parseProductIntelligenceOutput({
    category: "Furniture",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio", "lifestyle"],
    identityAnchors: { category: "Furniture", material: "Wood", primaryColor: "Brown" },
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });
  return row;
}

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/products/x", { headers: { "x-ai-imageshoot-e2e-shop": shop } });
}

async function cleanup() {
  await prisma.publishingJob.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

let worker: Worker | undefined;
let loader: typeof import("../../../app/routes/app.products.$id").loader;
let action: typeof import("../../../app/routes/app.products.$id").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ loader, action } = await import("../../../app/routes/app.products.$id"));
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
});

async function callLoader(shop: string, id: string) {
  return loader({ request: requestFor(shop), params: { id }, context: {} } as unknown as Parameters<typeof loader>[0]);
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

function waitForSucceeded(shop: string, productId: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callLoader(shop, productId);
      const productImagery = result.generationHistory.find((j) =>
        ["LIFESTYLE", "MODEL_SHOOT", "BANNER", "CTA"].includes(j.type),
      );
      if (productImagery?.status === "SUCCEEDED") {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${productImagery?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.products.$id — request-publish action", () => {
  it(
    "creates a real QUEUED PublishingJob for an approved product-imagery result",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");

      await callAction(SHOP_A, row.id, { intent: "generate-product-imagery", generationType: "LIFESTYLE" });
      await waitForSucceeded(SHOP_A, row.id);

      const loaded = await callLoader(SHOP_A, row.id);
      const job = loaded.generationHistory.find((j) => j.type === "LIFESTYLE")!;
      const result = job.results[job.results.length - 1];

      await callAction(SHOP_A, row.id, { intent: "review-generation-result", resultId: result.id, decision: "APPROVED" });

      const publishResult = await callAction(SHOP_A, row.id, {
        intent: "request-publish",
        sourceType: "GENERATION_RESULT",
        sourceResultId: result.id,
        targetProductId: row.id,
      });
      expect(publishResult).toEqual({ ok: true });

      const publishingJob = await prisma.publishingJob.findFirstOrThrow({ where: { shop: SHOP_A, sourceResultId: result.id } });
      expect(publishingJob.status).toBe("QUEUED");
      expect(publishingJob.targetProductId).toBe(row.id);
    },
    15000,
  );

  it("returns a merchant-safe error for a PENDING (not yet approved) result", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/2");

    await callAction(SHOP_A, row.id, { intent: "generate-product-imagery", generationType: "LIFESTYLE" });
    await waitForSucceeded(SHOP_A, row.id);
    const loaded = await callLoader(SHOP_A, row.id);
    const job = loaded.generationHistory.find((j) => j.type === "LIFESTYLE")!;
    const result = job.results[job.results.length - 1];

    const publishResult = await callAction(SHOP_A, row.id, {
      intent: "request-publish",
      sourceType: "GENERATION_RESULT",
      sourceResultId: result.id,
      targetProductId: row.id,
    });
    expect(publishResult).toEqual({ ok: false, error: "Only an approved result can be published." });
  });

  it("never lets a merchant publish another shop's result (tenant isolation)", async () => {
    const rowB = await seedAnalyzed(SHOP_B, "gid://shopify/Product/3");
    await callAction(SHOP_B, rowB.id, { intent: "generate-product-imagery", generationType: "LIFESTYLE" });
    await waitForSucceeded(SHOP_B, rowB.id);
    const loadedB = await callLoader(SHOP_B, rowB.id);
    const jobB = loadedB.generationHistory.find((j) => j.type === "LIFESTYLE")!;
    const resultB = jobB.results[jobB.results.length - 1];
    await callAction(SHOP_B, rowB.id, { intent: "review-generation-result", resultId: resultB.id, decision: "APPROVED" });

    const publishResult = await callAction(SHOP_A, rowB.id, {
      intent: "request-publish",
      sourceType: "GENERATION_RESULT",
      sourceResultId: resultB.id,
      targetProductId: rowB.id,
    });
    expect(publishResult).toEqual({ ok: false, error: "That result could no longer be found." });
  });
});
