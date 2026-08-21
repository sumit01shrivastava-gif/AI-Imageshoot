/**
 * Integration test: the `"product-intelligence"` queue, end to end —
 * `requestProductAnalysis` (the real service entry point) → real BullMQ
 * enqueue → real `processProductIntelligenceJob` worker → real provider
 * resolution (the deterministic test seam — see
 * services/intelligence/deterministic-test-provider.server.ts) → real
 * schema validation → real persistence. Against real local Postgres/Redis
 * (docker-compose — see tests/setup.ts).
 *
 * This is deliberately NOT a test that mocks the provider or the queue —
 * see the Phase 2 instructions ("Do NOT mock away the entire intelligence
 * workflow") and the Phase 0/1 audit (a test that bypassed the real queue
 * is exactly what let the original job-id bug through undetected).
 *
 * `AI_PROVIDER=deterministic-test` is set (and the cached `getEnv()`
 * result reset) in `beforeAll` — not at module load — for the same reason
 * tests/integration/routes/app.products.id-loader.test.ts sets
 * `ALLOW_E2E_AUTH_BYPASS` there: some of this file's imports transitively
 * reach modules that call `getEnv()` at their own top level, and ES module
 * imports are hoisted ahead of this file's own statements.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { ProductIntelligenceJobPayload } from "../../../services/intelligence/job.server";

const SHOP = "intel-queue-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Studio Sofa",
    handle: "studio-sofa",
    description: "A minimalist sofa.",
    productType: "Furniture",
    category: "Home & Garden > Furniture",
    vendor: "Acme Home",
    tags: ["sofa", "living-room"],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: "gid://shopify/MediaImage/1",
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

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
// Imported inside beforeAll, after the env seam is set up — see the
// top-of-file comment for why.
let requestProductAnalysis: typeof import("../../../services/intelligence/product-intelligence.server").requestProductAnalysis;
let getProductIntelligence: typeof import("../../../services/intelligence/product-intelligence.server").getProductIntelligence;
let processProductIntelligenceJob: typeof import("../../../services/intelligence/job.server").processProductIntelligenceJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ requestProductAnalysis, getProductIntelligence } = await import(
    "../../../services/intelligence/product-intelligence.server"
  ));
  ({ processProductIntelligenceJob } = await import("../../../services/intelligence/job.server"));

  worker = createWorker<ProductIntelligenceJobPayload>("product-intelligence", processProductIntelligenceJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

function waitForStatus(
  productId: string,
  status: "READY" | "FAILED",
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const row = await getProductIntelligence(CONTEXT, productId);
      if (row?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for status ${status}; last saw ${row?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("product-intelligence queue: end-to-end analysis", () => {
  it("analyzes a real product through the real queue, provider seam, validation, and persistence", async () => {
    await upsertSyncedProduct(SHOP, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });

    await requestProductAnalysis(CONTEXT, row.id);
    await waitForStatus(row.id, "READY");

    const intelligence = await getProductIntelligence(CONTEXT, row.id);
    expect(intelligence?.status).toBe("READY");
    // Furniture (per services/intelligence/category-recommendations.ts) is
    // not model-suitable and gets scene-oriented asset recommendations —
    // proves the real recommendation engine ran, not a stub.
    expect(intelligence?.modelSuitable).toBe(false);
    expect(intelligence?.recommendedAssetTypes.length).toBeGreaterThan(0);
    expect(intelligence?.providerName).toBe("deterministic-test");
    expect(intelligence?.sourceShopifyUpdatedAt?.toISOString()).toBe(
      new Date("2026-01-05T00:00:00Z").toISOString(),
    );
  });

  it("re-analysis (requesting analysis again on an already-READY product) runs again, not a silent no-op", async () => {
    await upsertSyncedProduct(SHOP, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });

    await requestProductAnalysis(CONTEXT, row.id);
    await waitForStatus(row.id, "READY");
    const first = await getProductIntelligence(CONTEXT, row.id);
    expect(first?.analysisVersion).toBe(1);

    await requestProductAnalysis(CONTEXT, row.id);
    // Wait past the point where a stuck/no-op job would have already
    // "succeeded" by doing nothing — assert the version actually moved.
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const poll = async () => {
        const current = await getProductIntelligence(CONTEXT, row.id);
        if (current && current.analysisVersion > 1) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("analysisVersion never advanced on re-analysis"));
          return;
        }
        setTimeout(poll, 50);
      };
      void poll();
    });

    const second = await getProductIntelligence(CONTEXT, row.id);
    expect(second?.analysisVersion).toBe(2);
  });

  it("throws ProductNotFoundError for a product id that doesn't belong to this shop (never trusts a client-supplied id)", async () => {
    const otherShop = `${SHOP}-other`;
    await upsertSyncedProduct(otherShop, product("gid://shopify/Product/1"));
    const otherRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: otherShop } });

    const { ProductNotFoundError } = await import(
      "../../../services/intelligence/product-intelligence.server"
    );
    await expect(requestProductAnalysis(CONTEXT, otherRow.id)).rejects.toThrow(ProductNotFoundError);

    await prisma.shopifyProduct.deleteMany({ where: { shop: otherShop } });
  });
});
