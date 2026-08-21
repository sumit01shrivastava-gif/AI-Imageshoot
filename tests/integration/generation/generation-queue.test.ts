/**
 * Integration test: the `"generation"` queue, end to end —
 * `requestGeneration` (the real service entry point) → real BullMQ
 * enqueue → real `processGenerationJob` worker → real deterministic
 * provider (services/generation/deterministic-test-provider.server.ts) →
 * result validation → real storage upload
 * (lib/storage/memory-provider.ts) → real persistence. Against real local
 * Postgres/Redis (docker-compose — see tests/setup.ts).
 *
 * Deliberately NOT a test that mocks the provider, storage, or the queue
 * — see the Phase 3 instructions ("do not mock away the queue") and
 * tests/integration/intelligence/product-intelligence-queue.test.ts,
 * which established this same pattern for Phase 2.
 *
 * `AI_PROVIDER=deterministic-test` is set (and the cached `getEnv()`
 * result reset) in `beforeAll` — not at module load — because some of
 * this file's imports transitively reach modules that call `getEnv()` at
 * their own top level, and ES module imports are hoisted ahead of this
 * file's own statements (see
 * tests/integration/routes/app.products.id-loader.test.ts for the same
 * reasoning applied to `ALLOW_E2E_AUTH_BYPASS`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";
import {
  FORCE_FAILURE_ALWAYS,
  FORCE_FAILURE_ONCE,
} from "../../../services/generation/deterministic-test-provider.server";

const SHOP = "gen-queue-test.myshopify.com";
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
    tags: ["sofa"],
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
let requestGeneration: typeof import("../../../services/generation/request-generation.server").requestGeneration;
let getGeneration: typeof import("../../../services/generation/request-generation.server").getGeneration;
let listGenerationHistory: typeof import("../../../services/generation/request-generation.server").listGenerationHistory;
let ProductNotFoundError: typeof import("../../../services/generation/request-generation.server").ProductNotFoundError;
let ProductNotAnalyzedError: typeof import("../../../services/generation/build-plan").ProductNotAnalyzedError;
let processGenerationJob: typeof import("../../../services/generation/job.server").processGenerationJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ requestGeneration, getGeneration, listGenerationHistory, ProductNotFoundError } = await import(
    "../../../services/generation/request-generation.server"
  ));
  ({ ProductNotAnalyzedError } = await import("../../../services/generation/build-plan"));
  ({ processGenerationJob } = await import("../../../services/generation/job.server"));

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

/** Seeds a product AND a READY Product Intelligence profile for it —
 * generation requires one (docs/generation.md "Identity preservation").
 * Writes directly through the repository rather than via the AI provider
 * seam Phase 2 already covers end to end — this file's job is proving
 * Phase 3's own pipeline. */
async function seedAnalyzedProduct(shopifyProductId: string) {
  await upsertSyncedProduct(SHOP, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId } });

  const data = parseProductIntelligenceOutput({
    category: "Furniture",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio", "scene"],
    identityAnchors: { category: "Furniture", material: "Wood", primaryColor: "Brown" },
    material: "Wood",
    primaryColor: "Brown",
    confidence: 0.8,
  });
  await saveIntelligenceResult(SHOP, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });

  return row;
}

function waitForStatus(
  generationJobId: string,
  status: "SUCCEEDED" | "FAILED",
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const job = await getGeneration(CONTEXT, generationJobId);
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

describe("generation queue: end-to-end", () => {
  it(
    "generates a real product through the real queue, provider seam, storage upload, and persistence",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, { productId: row.id, generationType: "PRODUCT_CLEANUP" });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.providerName).toBe("deterministic-test");
      expect(result?.results).toHaveLength(1);

      const [output] = result!.results;
      expect(output.storageKey).toContain(SHOP);
      expect(output.format).toBe("png");
      expect(output.width).toBe(1);
      expect(output.height).toBe(1);

      // Prove this is a REAL stored object, not just a DB row — see
      // docs/generation.md "Storage".
      const stored = await getConfiguredStorageProvider().download(output.storageKey);
      expect(stored.contentType).toBe("image/png");
      expect(stored.body.byteLength).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "a single request can produce multiple independently-identifiable results",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, {
        productId: row.id,
        generationType: "PRODUCT_CLEANUP",
        outputCountOverride: 3,
      });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.results).toHaveLength(3);
      const ids = new Set(result?.results.map((r) => r.id));
      expect(ids.size).toBe(3); // each independently identifiable
    },
    15000,
  );

  it(
    "a provider failure surfaces as FAILED with a merchant-safe message (never a raw provider error)",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, {
        productId: row.id,
        generationType: "PRODUCT_CLEANUP",
        visualDirectionOverride: { negativeConstraints: [FORCE_FAILURE_ALWAYS] },
      });
      await waitForStatus(job.id, "FAILED", 20000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.status).toBe("FAILED");
      expect(result?.errorMessage).toBe("Generation failed. Please try again in a moment.");
      expect(result?.errorMessage).not.toContain("deterministic-test provider: forced failure");
      expect(result?.results).toHaveLength(0);
    },
    25000,
  );

  it(
    "retries automatically on a transient provider failure and eventually succeeds",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, {
        productId: row.id,
        generationType: "PRODUCT_CLEANUP",
        visualDirectionOverride: { negativeConstraints: [FORCE_FAILURE_ONCE] },
      });
      await waitForStatus(job.id, "SUCCEEDED", 15000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.retryCount).toBeGreaterThanOrEqual(1);
      expect(result?.results).toHaveLength(1);
    },
    20000,
  );

  it(
    "regeneration (requesting generation again) creates a NEW, independent job — history is preserved, not overwritten",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const first = await requestGeneration(CONTEXT, { productId: row.id, generationType: "PRODUCT_CLEANUP" });
      await waitForStatus(first.id, "SUCCEEDED", 8000);

      const second = await requestGeneration(CONTEXT, { productId: row.id, generationType: "PRODUCT_CLEANUP" });
      expect(second.id).not.toBe(first.id);
      await waitForStatus(second.id, "SUCCEEDED", 8000);

      const history = await listGenerationHistory(CONTEXT, row.id);
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe(second.id); // most recent first
      expect(history[1].id).toBe(first.id);
      // The first generation's own result wasn't touched/removed by the second.
      expect(history[1].results).toHaveLength(1);
      expect(history[0].results).toHaveLength(1);
    },
    20000,
  );

  it("throws ProductNotFoundError for a product id that doesn't belong to this shop", async () => {
    const otherShop = `${SHOP}-other`;
    await upsertSyncedProduct(otherShop, product("gid://shopify/Product/1"));
    const otherRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: otherShop } });

    await expect(
      requestGeneration(CONTEXT, { productId: otherRow.id, generationType: "PRODUCT_CLEANUP" }),
    ).rejects.toThrow(ProductNotFoundError);

    await prisma.shopifyProduct.deleteMany({ where: { shop: otherShop } });
  });

  it("throws ProductNotAnalyzedError when Product Intelligence hasn't run for this product yet", async () => {
    await upsertSyncedProduct(SHOP, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });

    await expect(
      requestGeneration(CONTEXT, { productId: row.id, generationType: "PRODUCT_CLEANUP" }),
    ).rejects.toThrow(ProductNotAnalyzedError);
  });
});
