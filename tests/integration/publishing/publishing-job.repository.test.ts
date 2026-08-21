/**
 * Integration tests: db/repositories/publishing-job.repository.ts —
 * create/mark-lifecycle, tenant isolation, and the shop-wide history
 * listing. Against a real local Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import {
  createPublishingJob,
  markQueued,
  markProcessing,
  markSucceeded,
  markFailed,
  getPublishingJob,
  getLatestPublishingJobForSource,
  listPublishingHistoryForShop,
} from "../../../db/repositories/publishing-job.repository";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "publish-repo-test-a.myshopify.com";
const SHOP_B = "publish-repo-test-b.myshopify.com";
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
    shopifyUpdatedAt: new Date(),
    media: [],
  };
}

async function seedProduct(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  return prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
}

async function cleanup() {
  await prisma.publishingJob.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createPublishingJob / getPublishingJob", () => {
  it("creates a new PENDING row every time — never upserts", async () => {
    const productRow = await seedProduct(SHOP_A, "product-1");
    const first = await createPublishingJob({
      shop: SHOP_A,
      sourceType: "GENERATION_RESULT",
      sourceResultId: "result-1",
      targetProductId: productRow.id,
    });
    const second = await createPublishingJob({
      shop: SHOP_A,
      sourceType: "GENERATION_RESULT",
      sourceResultId: "result-1",
      targetProductId: productRow.id,
    });
    expect(first.id).not.toBe(second.id);
  });

  it("throws TenantMismatchError for another shop's job", async () => {
    const productRowB = await seedProduct(SHOP_B, "product-b1");
    const jobB = await createPublishingJob({
      shop: SHOP_B,
      sourceType: "PROCESSING_RESULT",
      sourceResultId: "result-b1",
      targetProductId: productRowB.id,
    });
    await expect(getPublishingJob(CONTEXT_A, jobB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a job id that doesn't exist", async () => {
    expect(await getPublishingJob(CONTEXT_A, "does-not-exist")).toBeNull();
  });
});

describe("mark* lifecycle", () => {
  it("markQueued/markProcessing/markSucceeded transition status and set timestamps", async () => {
    const productRow = await seedProduct(SHOP_A, "product-2");
    const job = await createPublishingJob({
      shop: SHOP_A,
      sourceType: "GENERATION_RESULT",
      sourceResultId: "result-2",
      targetProductId: productRow.id,
    });

    await markQueued(SHOP_A, job.id);
    let row = await getPublishingJob(CONTEXT_A, job.id);
    expect(row!.status).toBe("QUEUED");

    await markProcessing(SHOP_A, job.id, 1);
    row = await getPublishingJob(CONTEXT_A, job.id);
    expect(row!.status).toBe("PROCESSING");
    expect(row!.startedAt).not.toBeNull();

    await markSucceeded(SHOP_A, job.id, { shopifyMediaId: "gid://shopify/MediaImage/999", durationMs: 42 });
    row = await getPublishingJob(CONTEXT_A, job.id);
    expect(row!.status).toBe("SUCCEEDED");
    expect(row!.shopifyMediaId).toBe("gid://shopify/MediaImage/999");
    expect(row!.completedAt).not.toBeNull();
  });

  it("markFailed records a merchant-safe message, never mutates shopifyMediaId", async () => {
    const productRow = await seedProduct(SHOP_A, "product-3");
    const job = await createPublishingJob({
      shop: SHOP_A,
      sourceType: "STORE_VISUAL_RESULT",
      sourceResultId: "result-3",
      targetProductId: productRow.id,
    });

    await markFailed(SHOP_A, job.id, { message: "Publishing failed. Please try again in a moment.", durationMs: 10 });
    const row = await getPublishingJob(CONTEXT_A, job.id);
    expect(row!.status).toBe("FAILED");
    expect(row!.errorMessage).toBe("Publishing failed. Please try again in a moment.");
    expect(row!.shopifyMediaId).toBeNull();
  });

  it("mark* functions silently no-op for another shop's job id (defense in depth)", async () => {
    const productRowB = await seedProduct(SHOP_B, "product-b2");
    const jobB = await createPublishingJob({
      shop: SHOP_B,
      sourceType: "GENERATION_RESULT",
      sourceResultId: "result-b2",
      targetProductId: productRowB.id,
    });

    await markSucceeded(SHOP_A, jobB.id, { shopifyMediaId: "gid://shopify/MediaImage/hijacked", durationMs: 1 });
    const row = await prisma.publishingJob.findUniqueOrThrow({ where: { id: jobB.id } });
    expect(row.status).toBe("PENDING");
  });
});

describe("getLatestPublishingJobForSource", () => {
  it("returns the most recent job for a given source, or null if never published", async () => {
    const productRow = await seedProduct(SHOP_A, "product-4");
    expect(await getLatestPublishingJobForSource(SHOP_A, "GENERATION_RESULT", "result-4")).toBeNull();

    const first = await createPublishingJob({
      shop: SHOP_A,
      sourceType: "GENERATION_RESULT",
      sourceResultId: "result-4",
      targetProductId: productRow.id,
    });
    await markFailed(SHOP_A, first.id, { message: "failed", durationMs: 1 });

    const second = await createPublishingJob({
      shop: SHOP_A,
      sourceType: "GENERATION_RESULT",
      sourceResultId: "result-4",
      targetProductId: productRow.id,
    });

    const latest = await getLatestPublishingJobForSource(SHOP_A, "GENERATION_RESULT", "result-4");
    expect(latest!.id).toBe(second.id);
  });
});

describe("listPublishingHistoryForShop", () => {
  it("is shop-wide, most-recent-first, paginated, and never returns another shop's jobs", async () => {
    const productRow = await seedProduct(SHOP_A, "product-5");
    const jobs = [];
    for (let i = 0; i < 3; i += 1) {
      jobs.push(
        await createPublishingJob({
          shop: SHOP_A,
          sourceType: "GENERATION_RESULT",
          sourceResultId: `result-5-${i}`,
          targetProductId: productRow.id,
        }),
      );
    }
    const productRowB = await seedProduct(SHOP_B, "product-b5");
    await createPublishingJob({ shop: SHOP_B, sourceType: "GENERATION_RESULT", sourceResultId: "other", targetProductId: productRowB.id });

    const page1 = await listPublishingHistoryForShop(SHOP_A, {}, 1, 2);
    expect(page1.jobs).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.jobs[0].id).toBe(jobs[2].id);
  });

  it("filters by status", async () => {
    const productRow = await seedProduct(SHOP_A, "product-6");
    const job1 = await createPublishingJob({ shop: SHOP_A, sourceType: "GENERATION_RESULT", sourceResultId: "r1", targetProductId: productRow.id });
    await markSucceeded(SHOP_A, job1.id, { shopifyMediaId: "gid://shopify/MediaImage/1", durationMs: 1 });
    await createPublishingJob({ shop: SHOP_A, sourceType: "GENERATION_RESULT", sourceResultId: "r2", targetProductId: productRow.id });

    const succeededOnly = await listPublishingHistoryForShop(SHOP_A, { status: "SUCCEEDED" }, 1);
    expect(succeededOnly.jobs).toHaveLength(1);
    expect(succeededOnly.jobs[0].id).toBe(job1.id);
  });
});
