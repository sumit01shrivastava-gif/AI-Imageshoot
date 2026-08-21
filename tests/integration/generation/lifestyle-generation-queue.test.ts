/**
 * Integration test: LIFESTYLE generation through the real `"generation"`
 * queue end to end — mirrors generation-queue.test.ts's structure
 * (real requestGeneration → real BullMQ enqueue → real
 * processGenerationJob worker → real deterministic provider → real
 * storage upload → real persistence), scoped to what's new for Phase 5:
 * the lifestyleScene/brandStyle plan fields, the honest
 * identity-validation metadata, and result review status.
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

const SHOP = "lifestyle-gen-queue-test.myshopify.com";
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
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let requestGeneration: typeof import("../../../services/generation/request-generation.server").requestGeneration;
let getGeneration: typeof import("../../../services/generation/request-generation.server").getGeneration;
let reviewGenerationResult: typeof import("../../../services/generation/request-generation.server").reviewGenerationResult;
let GenerationResultNotFoundError: typeof import("../../../services/generation/request-generation.server").GenerationResultNotFoundError;
let processGenerationJob: typeof import("../../../services/generation/job.server").processGenerationJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ requestGeneration, getGeneration, reviewGenerationResult, GenerationResultNotFoundError } = await import(
    "../../../services/generation/request-generation.server"
  ));
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
    recommendedAssetTypes: ["product_studio", "lifestyle"],
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

describe("LIFESTYLE generation: end-to-end", () => {
  it(
    "generates a lifestyle image through the real pipeline, with a category-aware scene plan and honest identity-validation metadata",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, { productId: row.id, generationType: "LIFESTYLE" });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getGeneration(CONTEXT, job.id);
      expect(result?.status).toBe("SUCCEEDED");
      expect(result?.type).toBe("LIFESTYLE");

      // The plan snapshot taken at request time carries a real,
      // category-derived scene — never null for LIFESTYLE (see
      // build-plan.ts's LIFESTYLE branch).
      const plan = result!.plan as { lifestyleScene: { sceneType: string; surface: string | null } };
      expect(plan.lifestyleScene).not.toBeNull();
      expect(plan.lifestyleScene.sceneType).toBe("environmental");

      expect(result?.results).toHaveLength(1);
      const [output] = result!.results;
      // Every result defaults to PENDING review — approving/rejecting is a
      // separate, explicit merchant action (see db/repositories/
      // generation-job.repository.ts's setGenerationResultReviewStatus).
      expect(output.reviewStatus).toBe("PENDING");
      expect(output.reviewedAt).toBeNull();

      // The honest, non-semantic identity-validation boundary result — see
      // services/generation/identity-validation.server.ts.
      const metadata = output.metadata as { identityValidation: { validated: boolean; identityAnchorsChecked: string[] } };
      expect(metadata.identityValidation.validated).toBe(false);
      expect(metadata.identityValidation.identityAnchorsChecked).toEqual(
        expect.arrayContaining(["category", "shape", "material", "primaryColor", "constructionDetails", "distinctiveHardware"]),
      );
    },
    15000,
  );

  it("original product media is never mutated by a lifestyle generation request", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/1");
    const originalMedia = await prisma.shopifyProductMedia.findFirstOrThrow({ where: { productId: row.id } });

    const job = await requestGeneration(CONTEXT, { productId: row.id, generationType: "LIFESTYLE" });
    await waitForStatus(job.id, "SUCCEEDED", 8000);

    const reloadedMedia = await prisma.shopifyProductMedia.findUniqueOrThrow({ where: { id: originalMedia.id } });
    expect(reloadedMedia.originalUrl).toBe(originalMedia.originalUrl);
  });

  it(
    "a presetId resolves through the real preset service and shapes the plan's brandStyle/lifestyleScene",
    async () => {
      const row = await seedAnalyzedProduct("gid://shopify/Product/1");

      const job = await requestGeneration(CONTEXT, {
        productId: row.id,
        generationType: "LIFESTYLE",
        presetId: "luxury-editorial",
      });
      await waitForStatus(job.id, "SUCCEEDED", 8000);

      const result = await getGeneration(CONTEXT, job.id);
      const plan = result!.plan as {
        brandStyle: { photographyStyle: string } | null;
        lifestyleScene: { surface: string | null };
      };
      expect(plan.brandStyle?.photographyStyle).toBe("high-fashion editorial");
      expect(plan.lifestyleScene.surface).toBe("polished marble");
    },
    15000,
  );

  it("an unknown presetId is never an error — silently falls back to category-aware defaults", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/1");

    const job = await requestGeneration(CONTEXT, {
      productId: row.id,
      generationType: "LIFESTYLE",
      presetId: "does-not-exist",
    });
    await waitForStatus(job.id, "SUCCEEDED", 8000);

    const result = await getGeneration(CONTEXT, job.id);
    const plan = result!.plan as { brandStyle: unknown; lifestyleScene: { surface: string | null } };
    expect(plan.brandStyle).toBeNull();
    expect(plan.lifestyleScene.surface).not.toBeNull();
  });
});

describe("reviewGenerationResult", () => {
  it("approves a result, and rejects with GenerationResultNotFoundError for another shop's result", async () => {
    const row = await seedAnalyzedProduct("gid://shopify/Product/1");
    const job = await requestGeneration(CONTEXT, { productId: row.id, generationType: "LIFESTYLE" });
    await waitForStatus(job.id, "SUCCEEDED", 8000);

    const result = await getGeneration(CONTEXT, job.id);
    const [output] = result!.results;

    await reviewGenerationResult(CONTEXT, output.id, "APPROVED");
    const reloaded = await getGeneration(CONTEXT, job.id);
    expect(reloaded?.results[0].reviewStatus).toBe("APPROVED");

    const otherContext = { shop: `${SHOP}-other`, sessionId: "s1", isOnline: false };
    await expect(reviewGenerationResult(otherContext, output.id, "APPROVED")).rejects.toThrow(
      GenerationResultNotFoundError,
    );
  });
});
