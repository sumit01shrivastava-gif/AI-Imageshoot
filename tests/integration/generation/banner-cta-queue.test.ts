/**
 * Integration test: BANNER/CTA generation through the real `"generation"`
 * queue end to end — mirrors lifestyle-generation-queue.test.ts's and
 * model-shoot-queue.test.ts's structure. Covers what's new for Phase 7:
 * no modelSuitable-style gate (any analyzed product can get a banner/CTA),
 * the "no text/logo rendering" prompt instruction, and BANNER's own
 * default wide aspect ratio.
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
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP = "banner-cta-gen-queue-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Leather Tote Bag",
    handle: "leather-tote-bag",
    description: "A handcrafted leather tote.",
    productType: "Handbags",
    category: "Apparel & Accessories > Handbags",
    vendor: "Acme",
    tags: ["leather", "tote"],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: "gid://shopify/MediaImage/1",
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

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let requestGeneration: typeof import("../../../services/generation/request-generation.server").requestGeneration;
let getGeneration: typeof import("../../../services/generation/request-generation.server").getGeneration;
let processGenerationJob: typeof import("../../../services/generation/job.server").processGenerationJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ requestGeneration, getGeneration } = await import("../../../services/generation/request-generation.server"));
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

async function seedAnalyzedProduct(shopifyProductId: string) {
  await upsertSyncedProduct(SHOP, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId } });

  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio"],
    identityAnchors: {
      category: "Handbags",
      shape: "Rectangular",
      material: "Leather",
      primaryColor: "Brown",
      constructionDetails: ["structured body"],
      distinctiveHardware: ["gold clasp"],
      brandingVisible: false,
    },
    material: "Leather",
    primaryColor: "Brown",
    confidence: 0.85,
  });
  await saveIntelligenceResult(SHOP, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });

  return row;
}

function waitForStatus(generationJobId: string, status: "SUCCEEDED" | "FAILED", timeoutMs: number): Promise<void> {
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

describe("BANNER generation: end-to-end", () => {
  it(
    "generates a banner through the real pipeline, defaulting to a wide 21:9 ratio and a no-text instruction",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, {
        productId: row.id,
        generationType: "BANNER",
        presetId: "clean-commercial",
      });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.type).toBe("BANNER");

      const plan = result!.plan as { aspectRatio: string; brandStyle: unknown; creativeDirection: { prompt: string } };
      expect(plan.aspectRatio).toBe("21:9");
      expect(plan.brandStyle).not.toBeNull();
      expect(plan.creativeDirection.prompt).toContain("Promotional banner photography");
      expect(plan.creativeDirection.prompt).toContain("Do not render any text, logos, or typography");

      expect(result?.results).toHaveLength(1);
      expect(result?.results[0].reviewStatus).toBe("PENDING");
    },
    15000,
  );

  it("no modelSuitable gate — a category that's never model-suitable still gets a banner", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/2");
    // seedAnalyzedProduct already sets modelSuitable: false — this would
    // throw ProductNotModelSuitableError for MODEL_SHOOT but must not for
    // BANNER.
    await expect(requestGeneration(CONTEXT, { productId: row.id, generationType: "BANNER" })).resolves.toBeTruthy();
  });
});

describe("CTA generation: end-to-end", () => {
  it(
    "generates a CTA image through the real pipeline, defaulting to 1:1",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/3");

      const job = await requestGeneration(CONTEXT, { productId: row.id, generationType: "CTA", presetId: "luxury-editorial" });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.type).toBe("CTA");

      const plan = result!.plan as { aspectRatio: string; creativeDirection: { prompt: string } };
      expect(plan.aspectRatio).toBe("1:1");
      expect(plan.creativeDirection.prompt).toContain("call-to-action imagery");
    },
    15000,
  );

  it("original product media is never mutated by a BANNER/CTA generation request", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/4");
    const originalMedia = await prisma.shopifyProductMedia.findFirstOrThrow({ where: { productId: row.id } });

    const job = await requestGeneration(CONTEXT, { productId: row.id, generationType: "CTA" });
    await waitForStatus(job.id, "SUCCEEDED", 8000);

    const reloadedMedia = await prisma.shopifyProductMedia.findUniqueOrThrow({ where: { id: originalMedia.id } });
    expect(reloadedMedia.originalUrl).toBe(originalMedia.originalUrl);
  });
});
