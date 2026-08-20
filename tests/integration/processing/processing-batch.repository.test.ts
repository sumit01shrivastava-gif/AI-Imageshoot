/**
 * Integration tests: db/repositories/processing-batch.repository.ts —
 * batch creation, progress computation (groupBy, never a persisted
 * counter — see that file's `getBatchProgress` doc comment), and tenant
 * isolation. Against a real local Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { createProcessingJob, markProcessing, markSucceeded, markFailed } from "../../../db/repositories/processing-job.repository";
import { createBatch, getBatch, getBatchProgress } from "../../../db/repositories/processing-batch.repository";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "batch-repo-test-a.myshopify.com";
const SHOP_B = "batch-repo-test-b.myshopify.com";
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
    media: [
      {
        shopifyMediaId: `${shopifyProductId}-media`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/x.jpg",
        previewUrl: null,
        width: 100,
        height: 100,
        altText: null,
        position: 0,
      },
    ],
  };
}

async function seedProduct(shop: string, id: string) {
  await upsertSyncedProduct(shop, product(id));
  return prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId: id }, include: { media: true } });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.processingBatch.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createBatch / getBatch", () => {
  it("creates a batch and loads it back, shop-scoped", async () => {
    const batch = await createBatch({ shop: SHOP_A, operation: "REMOVE_BACKGROUND", sourceSelectionId: "sel-1" });
    const loaded = await getBatch(CONTEXT_A, batch.id);
    expect(loaded?.operation).toBe("REMOVE_BACKGROUND");
  });

  it("throws TenantMismatchError for another shop's batch", async () => {
    const batchB = await createBatch({ shop: SHOP_B, operation: "ENHANCE" });
    await expect(getBatch(CONTEXT_A, batchB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a batch id that doesn't exist", async () => {
    expect(await getBatch(CONTEXT_A, "does-not-exist")).toBeNull();
  });
});

describe("getBatchProgress", () => {
  it("returns all-zero progress for a batch with no jobs yet", async () => {
    const batch = await createBatch({ shop: SHOP_A, operation: "REMOVE_BACKGROUND" });
    const progress = await getBatchProgress(batch.id);
    expect(progress).toEqual({ total: 0, pending: 0, queued: 0, processing: 0, succeeded: 0, failed: 0, cancelled: 0 });
  });

  it("computes counts per status across the batch's jobs — never a stored counter that could drift", async () => {
    const batch = await createBatch({ shop: SHOP_A, operation: "REMOVE_BACKGROUND" });
    const rowA = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const rowB = await seedProduct(SHOP_A, "gid://shopify/Product/2");
    const rowC = await seedProduct(SHOP_A, "gid://shopify/Product/3");

    const jobA = await createProcessingJob({
      shop: SHOP_A,
      productId: rowA.id,
      sourceMediaId: rowA.media[0].id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
      batchId: batch.id,
    });
    const jobB = await createProcessingJob({
      shop: SHOP_A,
      productId: rowB.id,
      sourceMediaId: rowB.media[0].id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
      batchId: batch.id,
    });
    const jobC = await createProcessingJob({
      shop: SHOP_A,
      productId: rowC.id,
      sourceMediaId: rowC.media[0].id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
      batchId: batch.id,
    });

    // jobA succeeds, jobB fails, jobC stays PENDING — a batch that finishes
    // "partially succeeded" (see the section-12/7 requirement: one job
    // failing must not affect the others' independent progress).
    await markProcessing(SHOP_A, jobA.id, 1);
    await markSucceeded(SHOP_A, jobA.id, { providerName: "deterministic-test", durationMs: 10 });
    await markProcessing(SHOP_A, jobB.id, 1);
    await markFailed(SHOP_A, jobB.id, { message: "Processing failed. Please try again in a moment.", durationMs: 5 });

    const progress = await getBatchProgress(batch.id);
    expect(progress.total).toBe(3);
    expect(progress.succeeded).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.pending).toBe(1);
    expect(progress.queued).toBe(0);
    expect(progress.processing).toBe(0);

    void jobC; // referenced only to document its (PENDING) role above
  });

  it("only counts jobs actually in this batch, not other batches' jobs for the same shop", async () => {
    const batch1 = await createBatch({ shop: SHOP_A, operation: "REMOVE_BACKGROUND" });
    const batch2 = await createBatch({ shop: SHOP_A, operation: "REMOVE_BACKGROUND" });
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");

    await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: row.media[0].id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
      batchId: batch1.id,
    });

    const progress1 = await getBatchProgress(batch1.id);
    const progress2 = await getBatchProgress(batch2.id);
    expect(progress1.total).toBe(1);
    expect(progress2.total).toBe(0);
  });
});
