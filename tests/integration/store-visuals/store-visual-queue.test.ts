/**
 * Integration test: store-visual generation through the real
 * `"store-visuals"` queue end to end — mirrors
 * tests/integration/generation/lifestyle-generation-queue.test.ts's
 * structure. Covers what's new for store visuals: zero-product visuals,
 * multi-product visuals, tenant isolation on product references, and
 * per-visual-type aspect ratio defaults.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { StoreVisualJobPayload } from "../../../services/store-visuals/job.server";

const SHOP = "store-visual-queue-test.myshopify.com";
const OTHER_SHOP = "store-visual-queue-test-other.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string, title: string): SyncedProduct {
  return {
    shopifyProductId,
    title,
    handle: title.toLowerCase().replace(/\s+/g, "-"),
    description: "",
    productType: "Handbags",
    category: null,
    vendor: "Acme",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: `${shopifyProductId}-media`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/x.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: title,
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await prisma.storeVisualJob.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
}

let worker: Worker | undefined;
let requestStoreVisual: typeof import("../../../services/store-visuals/request-store-visual.server").requestStoreVisual;
let getStoreVisual: typeof import("../../../services/store-visuals/request-store-visual.server").getStoreVisual;
let reviewStoreVisualResult: typeof import("../../../services/store-visuals/request-store-visual.server").reviewStoreVisualResult;
let ProductNotFoundError: typeof import("../../../services/store-visuals/request-store-visual.server").ProductNotFoundError;
let processStoreVisualJob: typeof import("../../../services/store-visuals/job.server").processStoreVisualJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ requestStoreVisual, getStoreVisual, reviewStoreVisualResult, ProductNotFoundError } = await import(
    "../../../services/store-visuals/request-store-visual.server"
  ));
  ({ processStoreVisualJob } = await import("../../../services/store-visuals/job.server"));

  worker = createWorker<StoreVisualJobPayload>("store-visuals", processStoreVisualJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();

  // STORE_VISUAL_GENERATION is a plan-gated operation (FREE doesn't
  // include it — see services/billing/plans.ts); both test shops need a
  // real plan that does, since this suite exercises store visuals
  // directly, not billing itself. Seeded once, outside `cleanup()`'s
  // per-test deletions — removed in `afterAll` instead.
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.shopSubscription.upsert({
      where: { shop },
      create: { shop, planId: "STARTER", status: "ACTIVE" },
      update: { planId: "STARTER", status: "ACTIVE" },
    });
  }
});

afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});

afterAll(async () => {
  await cleanup();
  await prisma.shopSubscription.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

async function seedAnalyzedProduct(shopifyProductId: string, title: string, shop = SHOP) {
  await upsertSyncedProduct(shop, product(shopifyProductId, title));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });

  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio"],
    identityAnchors: { category: "Handbags", material: "Leather", primaryColor: "Brown" },
    material: "Leather",
    primaryColor: "Brown",
    confidence: 0.8,
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });

  return row;
}

function waitForStatus(id: string, status: "SUCCEEDED" | "FAILED", timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const job = await getStoreVisual(CONTEXT, id);
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

describe("store visual generation: end-to-end", () => {
  it(
    "generates a fully generic HOMEPAGE_HERO with zero products referenced",
    async () => {
      const job = await requestStoreVisual(CONTEXT, { visualType: "HOMEPAGE_HERO" });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getStoreVisual(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.type).toBe("HOMEPAGE_HERO");
      expect(result?.products).toEqual([]);
      expect(result?.results).toHaveLength(1);
      expect(result?.results[0].reviewStatus).toBe("PENDING");

      const plan = result!.plan as { aspectRatio: string; products: unknown[] };
      expect(plan.aspectRatio).toBe("21:9");
      expect(plan.products).toEqual([]);
    },
    15000,
  );

  it(
    "generates a COLLECTION_BANNER featuring multiple products",
    async () => {
      const p1 = await seedAnalyzedProduct("gid://shopify/Product/1", "Bag One");
      const p2 = await seedAnalyzedProduct("gid://shopify/Product/2", "Bag Two");

      const job = await requestStoreVisual(CONTEXT, {
        visualType: "COLLECTION_BANNER",
        productIds: [p1.id, p2.id],
        presetId: "clean-commercial",
      });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getStoreVisual(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.products.map((p) => p.productId).sort()).toEqual([p1.id, p2.id].sort());

      const plan = result!.plan as { products: Array<{ productId: string; identityAnchors: unknown }> };
      expect(plan.products).toHaveLength(2);
      expect(plan.products.every((p) => p.identityAnchors !== null)).toBe(true);
    },
    15000,
  );

  it("throws ProductNotFoundError for a product belonging to another shop — never leaked", async () => {
    const otherProduct = await seedAnalyzedProduct("gid://shopify/Product/1", "Other Shop Bag", OTHER_SHOP);
    await expect(
      requestStoreVisual(CONTEXT, { visualType: "STORE_CTA", productIds: [otherProduct.id] }),
    ).rejects.toThrow(ProductNotFoundError);
  });

  it("throws ProductNotFoundError for an id that doesn't exist at all", async () => {
    await expect(
      requestStoreVisual(CONTEXT, { visualType: "STORE_CTA", productIds: ["does-not-exist"] }),
    ).rejects.toThrow(ProductNotFoundError);
  });

  it("approve/reject a result, and regenerate creates a new independent job", async () => {
    const first = await requestStoreVisual(CONTEXT, { visualType: "STORE_CTA" });
    await waitForStatus(first.id, "SUCCEEDED", 8000);
    const firstResult = await getStoreVisual(CONTEXT, first.id);
    const resultId = firstResult!.results[0].id;

    await reviewStoreVisualResult(CONTEXT, resultId, "APPROVED");
    const reloaded = await getStoreVisual(CONTEXT, first.id);
    expect(reloaded?.results[0].reviewStatus).toBe("APPROVED");

    const second = await requestStoreVisual(CONTEXT, { visualType: "STORE_CTA" });
    expect(second.id).not.toBe(first.id);
    await waitForStatus(second.id, "SUCCEEDED", 8000);

    // The first, approved result is untouched by the second (independent)
    // request.
    const stillApproved = await getStoreVisual(CONTEXT, first.id);
    expect(stillApproved?.results[0].reviewStatus).toBe("APPROVED");
  });
});
