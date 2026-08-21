/**
 * Integration test: MODEL_SHOOT generation through the real
 * `"generation"` queue end to end — mirrors
 * lifestyle-generation-queue.test.ts's structure. Covers what's new for
 * Phase 6: the modelSuitable gate (ProductNotModelSuitableError), pose/
 * brandStyle resolution, and aspect ratio selection.
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

const SHOP = "model-shoot-gen-queue-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string, productType = "Handbags"): SyncedProduct {
  return {
    shopifyProductId,
    title: "Leather Tote Bag",
    handle: "leather-tote-bag",
    description: "A handcrafted leather tote.",
    productType,
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
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let requestGeneration: typeof import("../../../services/generation/request-generation.server").requestGeneration;
let getGeneration: typeof import("../../../services/generation/request-generation.server").getGeneration;
let processGenerationJob: typeof import("../../../services/generation/job.server").processGenerationJob;
let ProductNotModelSuitableError: typeof import("../../../services/generation/build-plan").ProductNotModelSuitableError;
let InvalidGenerationRequestError: typeof import("../../../services/generation/request-generation.server").InvalidGenerationRequestError;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ requestGeneration, getGeneration } = await import("../../../services/generation/request-generation.server"));
  ({ InvalidGenerationRequestError } = await import("../../../services/generation/request-generation.server"));
  ({ ProductNotModelSuitableError } = await import("../../../services/generation/build-plan"));
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

async function seedAnalyzedProduct(shopifyProductId: string, { modelSuitable = true }: { modelSuitable?: boolean | null } = {}) {
  await upsertSyncedProduct(SHOP, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId } });

  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable,
    recommendedAssetTypes: ["product_studio", "lifestyle"],
    recommendedPoseTypes: modelSuitable ? ["carried/worn detail"] : [],
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

describe("MODEL_SHOOT generation: end-to-end", () => {
  it(
    "generates a model image through the real pipeline, with a resolved pose and brand style",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, {
        productId: row.id,
        generationType: "MODEL_SHOOT",
        presetId: "premium-modern",
        aspectRatio: "4:5",
      });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.type).toBe("MODEL_SHOOT");

      const plan = result!.plan as {
        aspectRatio: string;
        brandStyle: unknown;
        lifestyleScene: unknown;
        creativeDirection: { prompt: string };
      };
      expect(plan.aspectRatio).toBe("4:5");
      expect(plan.brandStyle).not.toBeNull();
      expect(plan.lifestyleScene).toBeNull();
      expect(plan.creativeDirection.prompt).toContain("Model photography");

      expect(result?.results).toHaveLength(1);
      expect(result?.results[0].reviewStatus).toBe("PENDING");
    },
    15000,
  );

  it("throws ProductNotModelSuitableError (via requestGeneration) for a product Product Intelligence marked unsuitable", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/2", { modelSuitable: false });
    await expect(requestGeneration(CONTEXT, { productId: row.id, generationType: "MODEL_SHOOT" })).rejects.toThrow(
      ProductNotModelSuitableError,
    );
  });

  // The "modelSuitable was never determined (null)" case is covered at the
  // build-plan.ts unit level (tests/unit/generation/build-plan.test.ts) —
  // not reachable through this real pipeline, since
  // parseProductIntelligenceOutput requires modelSuitable to be a real
  // boolean; `null` only ever occurs for a product that was never
  // analyzed at all, which requestGeneration already rejects earlier via
  // ProductNotAnalyzedError.

  it("throws InvalidGenerationRequestError for an unknown aspect ratio — never silently substitutes a default", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/4");
    await expect(
      requestGeneration(CONTEXT, { productId: row.id, generationType: "MODEL_SHOOT", aspectRatio: "3:2" }),
    ).rejects.toThrow(InvalidGenerationRequestError);
  });

  it("original product media is never mutated by a model-shoot generation request", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/5");
    const originalMedia = await prisma.shopifyProductMedia.findFirstOrThrow({ where: { productId: row.id } });

    const job = await requestGeneration(CONTEXT, { productId: row.id, generationType: "MODEL_SHOOT" });
    await waitForStatus(job.id, "SUCCEEDED", 8000);

    const reloadedMedia = await prisma.shopifyProductMedia.findUniqueOrThrow({ where: { id: originalMedia.id } });
    expect(reloadedMedia.originalUrl).toBe(originalMedia.originalUrl);
  });
});
