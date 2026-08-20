/**
 * Integration tests: db/repositories/processing-job.repository.ts against
 * a real local Postgres (docker-compose — see tests/setup.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import {
  createProcessingJob,
  markQueued,
  markProcessing,
  markSucceeded,
  markFailed,
  createResult,
  getProcessingJob,
  listProcessingJobsForProduct,
  setResultReviewStatus,
} from "../../../db/repositories/processing-job.repository";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "proc-repo-test-a.myshopify.com";
const SHOP_B = "proc-repo-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Red Leather Handbag",
    handle: "red-leather-handbag",
    description: "",
    productType: "Handbags",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    media: [
      {
        shopifyMediaId: `${shopifyProductId}-media-1`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/handbag.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Handbag",
        position: 0,
      },
    ],
  };
}

async function seedProduct(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  return prisma.shopifyProduct.findFirstOrThrow({
    where: { shop, shopifyProductId },
    include: { media: true },
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createProcessingJob", () => {
  it("creates a new PENDING row every time — never upserts/overwrites a prior one", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];

    const first = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });
    const second = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });

    expect(first.id).not.toBe(second.id);
    const all = await prisma.processingJob.findMany({ where: { productId: row.id } });
    expect(all).toHaveLength(2);
    expect(all.every((j) => j.status === "PENDING")).toBe(true);
  });
});

describe("job lifecycle", () => {
  it("PENDING -> QUEUED -> PROCESSING -> SUCCEEDED, with a result attached", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];

    const job = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: { category: "Handbags" },
    });

    expect((await getProcessingJob(CONTEXT_A, job.id))?.status).toBe("PENDING");

    await markQueued(SHOP_A, job.id);
    expect((await getProcessingJob(CONTEXT_A, job.id))?.status).toBe("QUEUED");

    await markProcessing(SHOP_A, job.id, 1);
    const processing = await getProcessingJob(CONTEXT_A, job.id);
    expect(processing?.status).toBe("PROCESSING");
    expect(processing?.retryCount).toBe(0);
    expect(processing?.startedAt).not.toBeNull();
    expect(processing?.identityAnchors).toEqual({ category: "Handbags" });

    await createResult(SHOP_A, job.id, {
      storageKey: "shops/test/processing/1/0.png",
      url: "/media/shops/test/processing/1/0.png?expires=1&sig=abc",
      width: 800,
      height: 600,
      format: "png",
      providerName: "deterministic-test",
      providerResultId: "result-1",
      metadata: { operation: "removeBackground" },
    });
    await markSucceeded(SHOP_A, job.id, { providerName: "deterministic-test", durationMs: 90 });

    const succeeded = await getProcessingJob(CONTEXT_A, job.id);
    expect(succeeded?.status).toBe("SUCCEEDED");
    expect(succeeded?.providerName).toBe("deterministic-test");
    expect(succeeded?.durationMs).toBe(90);
    expect(succeeded?.results).toHaveLength(1);
    expect(succeeded?.results[0].storageKey).toBe("shops/test/processing/1/0.png");
    expect(succeeded?.results[0].reviewStatus).toBe("PENDING");
    // Original source image reference is exposed but never mutated by
    // this repository — see "original preservation" in the queue-level
    // integration test.
    expect(succeeded?.sourceMedia.originalUrl).toBe("https://cdn.shopify.com/handbag.jpg");
    expect(succeeded?.product.title).toBe("Red Leather Handbag");
  });

  it("markProcessing only sets startedAt once, across repeated (retry) calls", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];
    const job = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "ENHANCE",
      options: {},
      identityAnchors: null,
    });

    await markProcessing(SHOP_A, job.id, 1);
    const firstStartedAt = (await getProcessingJob(CONTEXT_A, job.id))?.startedAt;

    await markProcessing(SHOP_A, job.id, 2);
    const afterRetry = await getProcessingJob(CONTEXT_A, job.id);
    expect(afterRetry?.startedAt?.toISOString()).toBe(firstStartedAt?.toISOString());
    expect(afterRetry?.retryCount).toBe(1);
  });

  it("PROCESSING -> FAILED, with a merchant-safe message and no results — original image untouched", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];
    const job = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });

    await markProcessing(SHOP_A, job.id, 1);
    await markFailed(SHOP_A, job.id, { message: "Processing failed. Please try again in a moment.", durationMs: 40 });

    const failed = await getProcessingJob(CONTEXT_A, job.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.errorMessage).toBe("Processing failed. Please try again in a moment.");
    expect(failed?.results).toHaveLength(0);

    // A failed job must not destroy the source image.
    const mediaRow = await prisma.shopifyProductMedia.findUniqueOrThrow({ where: { id: media.id } });
    expect(mediaRow.originalUrl).toBe("https://cdn.shopify.com/handbag.jpg");
  });
});

describe("resize aspect-ratio options persist through the round trip", () => {
  it("stores and returns the operation-specific options", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];
    const job = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "RESIZE",
      options: { aspectRatio: "4:5" },
      identityAnchors: null,
    });

    const loaded = await getProcessingJob(CONTEXT_A, job.id);
    expect(loaded?.options).toEqual({ aspectRatio: "4:5" });
  });
});

describe("history", () => {
  it("preserves every processing request as its own row, most-recent-first", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];

    const first = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });
    const second = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });

    const history = await listProcessingJobsForProduct(CONTEXT_A, row.id);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(second.id);
    expect(history[1].id).toBe(first.id);
  });
});

describe("review decisions", () => {
  it("setResultReviewStatus approves a result and records reviewedAt, without touching other results", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];
    const job = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });
    await createResult(SHOP_A, job.id, {
      storageKey: "k1",
      url: null,
      width: null,
      height: null,
      format: null,
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    });
    const [result] = (await getProcessingJob(CONTEXT_A, job.id))!.results;

    const updated = await setResultReviewStatus(CONTEXT_A, result.id, "APPROVED");
    expect(updated).toBe(true);

    const reloaded = await getProcessingJob(CONTEXT_A, job.id);
    expect(reloaded?.results[0].reviewStatus).toBe("APPROVED");
    expect(reloaded?.results[0].reviewedAt).not.toBeNull();
    // The result row itself (storageKey) is unchanged by review — approving
    // never mutates/deletes the asset.
    expect(reloaded?.results[0].storageKey).toBe("k1");
  });

  it("rejecting a result preserves it (never deletes it)", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];
    const job = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });
    await createResult(SHOP_A, job.id, {
      storageKey: "k2",
      url: null,
      width: null,
      height: null,
      format: null,
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    });
    const [result] = (await getProcessingJob(CONTEXT_A, job.id))!.results;

    await setResultReviewStatus(CONTEXT_A, result.id, "REJECTED");

    const reloaded = await getProcessingJob(CONTEXT_A, job.id);
    expect(reloaded?.results).toHaveLength(1); // still present
    expect(reloaded?.results[0].reviewStatus).toBe("REJECTED");
  });

  it("returns false for a result belonging to another shop — never updates it", async () => {
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/1");
    const mediaB = rowB.media[0];
    const jobB = await createProcessingJob({
      shop: SHOP_B,
      productId: rowB.id,
      sourceMediaId: mediaB.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });
    await createResult(SHOP_B, jobB.id, {
      storageKey: "k3",
      url: null,
      width: null,
      height: null,
      format: null,
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    });
    const [resultB] = (await prisma.processingResult.findMany({ where: { processingJobId: jobB.id } }))!;

    const updated = await setResultReviewStatus(CONTEXT_A, resultB.id, "APPROVED");
    expect(updated).toBe(false);

    const stillPending = await prisma.processingResult.findUniqueOrThrow({ where: { id: resultB.id } });
    expect(stillPending.reviewStatus).toBe("PENDING");
  });
});

describe("tenant isolation", () => {
  it("getProcessingJob throws TenantMismatchError rather than returning another shop's job", async () => {
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/1");
    const mediaB = rowB.media[0];
    const jobB = await createProcessingJob({
      shop: SHOP_B,
      productId: rowB.id,
      sourceMediaId: mediaB.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });

    await expect(getProcessingJob(CONTEXT_A, jobB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a processing job id that doesn't exist", async () => {
    expect(await getProcessingJob(CONTEXT_A, "does-not-exist")).toBeNull();
  });

  it("listProcessingJobsForProduct never returns another shop's jobs", async () => {
    const rowA = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/2");
    await createProcessingJob({
      shop: SHOP_B,
      productId: rowB.id,
      sourceMediaId: rowB.media[0].id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });

    expect(await listProcessingJobsForProduct(CONTEXT_A, rowA.id)).toHaveLength(0);
  });

  it("deleting the underlying product cascades to its processing jobs and results", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const media = row.media[0];
    const job = await createProcessingJob({
      shop: SHOP_A,
      productId: row.id,
      sourceMediaId: media.id,
      operation: "REMOVE_BACKGROUND",
      options: {},
      identityAnchors: null,
    });
    await createResult(SHOP_A, job.id, {
      storageKey: "k",
      url: null,
      width: null,
      height: null,
      format: null,
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    });

    await prisma.shopifyProduct.delete({ where: { id: row.id } });

    expect(await prisma.processingJob.findMany({ where: { productId: row.id } })).toHaveLength(0);
    expect(await prisma.processingResult.findMany({ where: { processingJobId: job.id } })).toHaveLength(0);
  });
});
