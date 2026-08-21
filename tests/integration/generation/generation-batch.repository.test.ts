/**
 * Integration tests: db/repositories/generation-batch.repository.ts —
 * batch creation, progress computation (groupBy, never a persisted
 * counter — see that file's `getGenerationBatchProgress` doc comment),
 * and tenant isolation. Against a real local Postgres. Mirrors
 * tests/integration/processing/processing-batch.repository.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { createGenerationJob, markProcessing, markSucceeded, markFailed } from "../../../db/repositories/generation-job.repository";
import { createGenerationBatch, getGenerationBatch, getGenerationBatchProgress } from "../../../db/repositories/generation-batch.repository";
import { parseGenerationPlan } from "../../../services/generation/schema";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "gen-batch-repo-test-a.myshopify.com";
const SHOP_B = "gen-batch-repo-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Product",
    handle: "product",
    description: "",
    productType: "",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [],
  };
}

function plan() {
  return parseGenerationPlan({
    generationType: "LIFESTYLE",
    assetType: "lifestyle",
    category: "Handbags",
    sourceProductId: "product-1",
    sourceImages: [{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 }],
    productFacts: {
      identityAnchors: {
        category: "Handbags",
        shape: null,
        material: "Leather",
        primaryColor: "Red",
        constructionDetails: [],
        distinctiveHardware: [],
        brandingVisible: false,
        brandingDescription: null,
      },
    },
    creativeDirection: {
      prompt: "Lifestyle photography of the red leather handbag.",
      negativeConstraints: [],
      environment: null,
      lighting: null,
      composition: null,
    },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    modelConfiguration: null,
    brandStyle: null,
    lifestyleScene: null,
    constraints: [],
  });
}

async function seedProduct(shop: string, id: string) {
  await upsertSyncedProduct(shop, product(id));
  return prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId: id } });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.generationBatch.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createGenerationBatch / getGenerationBatch", () => {
  it("creates a batch and loads it back, shop-scoped", async () => {
    const batch = await createGenerationBatch({ shop: SHOP_A, generationType: "LIFESTYLE", sourceSelectionId: "sel-1" });
    const loaded = await getGenerationBatch(CONTEXT_A, batch.id);
    expect(loaded?.generationType).toBe("LIFESTYLE");
  });

  it("throws TenantMismatchError for another shop's batch", async () => {
    const batchB = await createGenerationBatch({ shop: SHOP_B, generationType: "LIFESTYLE" });
    await expect(getGenerationBatch(CONTEXT_A, batchB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a batch id that doesn't exist", async () => {
    expect(await getGenerationBatch(CONTEXT_A, "does-not-exist")).toBeNull();
  });
});

describe("getGenerationBatchProgress", () => {
  it("returns all-zero progress for a batch with no jobs yet", async () => {
    const batch = await createGenerationBatch({ shop: SHOP_A, generationType: "LIFESTYLE" });
    const progress = await getGenerationBatchProgress(batch.id);
    expect(progress).toEqual({ total: 0, pending: 0, queued: 0, processing: 0, succeeded: 0, failed: 0, cancelled: 0 });
  });

  it("computes counts per status across the batch's jobs — never a stored counter that could drift", async () => {
    const batch = await createGenerationBatch({ shop: SHOP_A, generationType: "LIFESTYLE" });
    const rowA = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const rowB = await seedProduct(SHOP_A, "gid://shopify/Product/2");
    const rowC = await seedProduct(SHOP_A, "gid://shopify/Product/3");

    const jobA = await createGenerationJob({
      shop: SHOP_A,
      productId: rowA.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
      batchId: batch.id,
    });
    const jobB = await createGenerationJob({
      shop: SHOP_A,
      productId: rowB.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
      batchId: batch.id,
    });
    const jobC = await createGenerationJob({
      shop: SHOP_A,
      productId: rowC.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
      batchId: batch.id,
    });

    // jobA succeeds, jobB fails, jobC stays PENDING — a batch that finishes
    // "partially succeeded" must not affect the others' independent
    // progress (same requirement Phase 4's batch processing proved).
    await markProcessing(SHOP_A, jobA.id, 1);
    await markSucceeded(SHOP_A, jobA.id, { providerName: "deterministic-test", providerJobId: "j1", durationMs: 10 });
    await markProcessing(SHOP_A, jobB.id, 1);
    await markFailed(SHOP_A, jobB.id, { message: "Generation failed. Please try again in a moment.", durationMs: 5 });

    const progress = await getGenerationBatchProgress(batch.id);
    expect(progress.total).toBe(3);
    expect(progress.succeeded).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.pending).toBe(1);
    expect(progress.queued).toBe(0);
    expect(progress.processing).toBe(0);

    void jobC; // referenced only to document its (PENDING) role above
  });

  it("only counts jobs actually in this batch, not other batches' jobs for the same shop", async () => {
    const batch1 = await createGenerationBatch({ shop: SHOP_A, generationType: "LIFESTYLE" });
    const batch2 = await createGenerationBatch({ shop: SHOP_A, generationType: "LIFESTYLE" });
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");

    await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
      batchId: batch1.id,
    });

    const progress1 = await getGenerationBatchProgress(batch1.id);
    const progress2 = await getGenerationBatchProgress(batch2.id);
    expect(progress1.total).toBe(1);
    expect(progress2.total).toBe(0);
  });
});
