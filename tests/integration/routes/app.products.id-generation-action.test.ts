/**
 * Integration test for app/routes/app.products.$id.tsx's Image Generation
 * loader data + "generate" action — the route layer of the route →
 * service → provider → validation → storage → persistence → UI chain (see
 * tests/integration/generation/generation-queue.test.ts for the service/
 * provider/storage/persistence layers, and tests/e2e/ for the full
 * browser-driven path).
 *
 * Authenticates via the E2E test seam — see
 * tests/integration/routes/app.products.id-loader.test.ts for why
 * `ALLOW_E2E_AUTH_BYPASS`/`AI_PROVIDER` are set in `beforeAll`, not at
 * module load (ES module import hoisting).
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

const SHOP_A = "route-gen-a.myshopify.com";
const SHOP_B = "route-gen-b.myshopify.com";

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

async function seedAnalyzed(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
  const data = parseProductIntelligenceOutput({
    category: "Furniture",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio"],
    identityAnchors: { category: "Furniture" },
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });
  return row;
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

function waitForGenerationStatus(
  shop: string,
  id: string,
  status: "SUCCEEDED" | "FAILED",
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callLoader(shop, id);
      if (result.generationHistory[0]?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${result.generationHistory[0]?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.products.$id — Image Generation loader data", () => {
  it("generationHistory is empty for a product with no generation yet", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");
    const result = await callLoader(SHOP_A, row.id);
    expect(result.generationHistory).toEqual([]);
  });
});

describe("app.products.$id — 'generate' action", () => {
  it(
    "queues generation, and the loader eventually reflects the completed result",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");

      const actionResult = await callAction(SHOP_A, row.id, { intent: "generate" });
      expect(actionResult).toEqual({ ok: true });

      await waitForGenerationStatus(SHOP_A, row.id, "SUCCEEDED");

      const result = await callLoader(SHOP_A, row.id);
      expect(result.generationHistory).toHaveLength(1);
      expect(result.generationHistory[0].status).toBe("SUCCEEDED");
      expect(result.generationHistory[0].results.length).toBeGreaterThan(0);
    },
    15000,
  );

  it("returns a merchant-safe, guiding error when the product hasn't been analyzed yet", async () => {
    await upsertSyncedProduct(SHOP_A, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_A } });

    const result = await callAction(SHOP_A, row.id, { intent: "generate" });
    expect(result).toEqual({
      ok: false,
      error: "This product must be analyzed (Product Intelligence) before generating images.",
    });
  });

  it("throws a safe 404 — not a raw TenantMismatchError — for a product belonging to another shop", async () => {
    const otherRow = await seedAnalyzed(SHOP_B, "gid://shopify/Product/1");

    let caught: unknown;
    try {
      await callAction(SHOP_A, otherRow.id, { intent: "generate" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
    expect(await (caught as Response).text()).toBe("Product not found");
  });
});
