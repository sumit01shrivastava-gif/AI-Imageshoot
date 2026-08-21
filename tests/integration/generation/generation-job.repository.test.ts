/**
 * Integration tests: db/repositories/generation-job.repository.ts against
 * a real local Postgres (docker-compose — see tests/setup.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import {
  createGenerationJob,
  markQueued,
  markProcessing,
  markSucceeded,
  markFailed,
  createResults,
  getGenerationJob,
  listGenerationJobsForProduct,
  listGenerationJobsForBatch,
  setGenerationResultReviewStatus,
} from "../../../db/repositories/generation-job.repository";
import { createGenerationBatch } from "../../../db/repositories/generation-batch.repository";
import { parseGenerationPlan } from "../../../services/generation/schema";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "gen-repo-test-a.myshopify.com";
const SHOP_B = "gen-repo-test-b.myshopify.com";
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
    media: [],
  };
}

function plan() {
  return parseGenerationPlan({
    generationType: "PRODUCT_CLEANUP",
    assetType: "product_studio",
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
      prompt: "Clean product photography of the red leather handbag.",
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

async function seedProduct(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  return prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
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

describe("createGenerationJob", () => {
  it("creates a new PENDING row every time — never upserts/overwrites a prior one", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const builtPlan = plan();

    const first = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: builtPlan,
    });
    const second = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: builtPlan,
    });

    expect(first.id).not.toBe(second.id);
    const all = await prisma.generationJob.findMany({ where: { productId: row.id } });
    expect(all).toHaveLength(2);
    expect(all.every((j) => j.status === "PENDING")).toBe(true);
  });
});

describe("job lifecycle", () => {
  it("PENDING -> QUEUED -> PROCESSING -> SUCCEEDED, with results attached", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    expect((await getGenerationJob(CONTEXT_A, job.id))?.status).toBe("PENDING");

    await markQueued(SHOP_A, job.id);
    expect((await getGenerationJob(CONTEXT_A, job.id))?.status).toBe("QUEUED");

    await markProcessing(SHOP_A, job.id, 1);
    const processing = await getGenerationJob(CONTEXT_A, job.id);
    expect(processing?.status).toBe("PROCESSING");
    expect(processing?.retryCount).toBe(0);
    expect(processing?.startedAt).not.toBeNull();

    await createResults(SHOP_A, job.id, [
      {
        storageKey: "shops/test/generations/1/0.png",
        url: "memory://shops/test/generations/1/0.png",
        width: 1,
        height: 1,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: "result-1",
        metadata: { seed: 42 },
      },
    ]);
    await markSucceeded(SHOP_A, job.id, {
      providerName: "deterministic-test",
      providerJobId: "job-1",
      durationMs: 120,
    });

    const succeeded = await getGenerationJob(CONTEXT_A, job.id);
    expect(succeeded?.status).toBe("SUCCEEDED");
    expect(succeeded?.providerName).toBe("deterministic-test");
    expect(succeeded?.providerJobId).toBe("job-1");
    expect(succeeded?.durationMs).toBe(120);
    expect(succeeded?.results).toHaveLength(1);
    expect(succeeded?.results[0].storageKey).toBe("shops/test/generations/1/0.png");
    expect(succeeded?.results[0].metadata).toEqual({ seed: 42 });
    expect(succeeded?.results[0].reviewStatus).toBe("PENDING");
    // For the review UI's "original vs. generated" comparison — see
    // db/repositories/generation-job.repository.ts's JOB_SELECT comment.
    expect(succeeded?.product.title).toBe("Red Leather Handbag");
  });

  it("markProcessing only sets startedAt once, across repeated (retry) calls", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    await markProcessing(SHOP_A, job.id, 1);
    const firstStartedAt = (await getGenerationJob(CONTEXT_A, job.id))?.startedAt;

    await markProcessing(SHOP_A, job.id, 2);
    const afterRetry = await getGenerationJob(CONTEXT_A, job.id);
    expect(afterRetry?.startedAt?.toISOString()).toBe(firstStartedAt?.toISOString());
    expect(afterRetry?.retryCount).toBe(1);
  });

  it("PROCESSING -> FAILED, with a merchant-safe message and no results", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    await markProcessing(SHOP_A, job.id, 1);
    await markFailed(SHOP_A, job.id, { message: "Generation failed. Please try again in a moment.", durationMs: 50 });

    const failed = await getGenerationJob(CONTEXT_A, job.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.errorMessage).toBe("Generation failed. Please try again in a moment.");
    expect(failed?.results).toHaveLength(0);
  });

  it("a single job can carry multiple results", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    await createResults(
      SHOP_A,
      job.id,
      [0, 1, 2].map((index) => ({
        storageKey: `shops/test/generations/${job.id}/${index}.png`,
        url: null,
        width: 1,
        height: 1,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: `result-${index}`,
        metadata: null,
      })),
    );

    const withResults = await getGenerationJob(CONTEXT_A, job.id);
    expect(withResults?.results).toHaveLength(3);
    expect(withResults?.results.map((r) => r.providerResultId)).toEqual(["result-0", "result-1", "result-2"]);
  });
});

describe("generation history", () => {
  it("preserves every generation as its own row, most-recent-first", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");

    const first = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });
    const second = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    const history = await listGenerationJobsForProduct(CONTEXT_A, row.id);
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(second.id);
    expect(history[1].id).toBe(first.id);
  });
});

describe("review decisions", () => {
  it("setGenerationResultReviewStatus approves a result and records reviewedAt, without touching other results", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });
    await createResults(SHOP_A, job.id, [
      {
        storageKey: "k1",
        url: null,
        width: null,
        height: null,
        format: null,
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);
    const [result] = (await getGenerationJob(CONTEXT_A, job.id))!.results;

    const updated = await setGenerationResultReviewStatus(CONTEXT_A, result.id, "APPROVED");
    expect(updated).toBe(true);

    const reloaded = await getGenerationJob(CONTEXT_A, job.id);
    expect(reloaded?.results[0].reviewStatus).toBe("APPROVED");
    expect(reloaded?.results[0].reviewedAt).not.toBeNull();
    // The result row itself (storageKey) is unchanged by review — approving
    // never mutates/deletes the asset.
    expect(reloaded?.results[0].storageKey).toBe("k1");
  });

  it("rejecting a result preserves it (never deletes it)", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });
    await createResults(SHOP_A, job.id, [
      {
        storageKey: "k2",
        url: null,
        width: null,
        height: null,
        format: null,
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);
    const [result] = (await getGenerationJob(CONTEXT_A, job.id))!.results;

    await setGenerationResultReviewStatus(CONTEXT_A, result.id, "REJECTED");

    const reloaded = await getGenerationJob(CONTEXT_A, job.id);
    expect(reloaded?.results).toHaveLength(1); // still present
    expect(reloaded?.results[0].reviewStatus).toBe("REJECTED");
  });

  it("returns false for a result belonging to another shop — never updates it", async () => {
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/1");
    const jobB = await createGenerationJob({
      shop: SHOP_B,
      productId: rowB.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });
    await createResults(SHOP_B, jobB.id, [
      {
        storageKey: "k3",
        url: null,
        width: null,
        height: null,
        format: null,
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);
    const [resultB] = await prisma.generationResult.findMany({ where: { generationJobId: jobB.id } });

    const updated = await setGenerationResultReviewStatus(CONTEXT_A, resultB.id, "APPROVED");
    expect(updated).toBe(false);

    const stillPending = await prisma.generationResult.findUniqueOrThrow({ where: { id: resultB.id } });
    expect(stillPending.reviewStatus).toBe("PENDING");
  });
});

describe("batch support", () => {
  it("createGenerationJob accepts an optional batchId, and listGenerationJobsForBatch returns only that batch's jobs", async () => {
    const rowA = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const rowB = await seedProduct(SHOP_A, "gid://shopify/Product/2");
    const batch1 = await createGenerationBatch({ shop: SHOP_A, generationType: "LIFESTYLE" });
    const batch2 = await createGenerationBatch({ shop: SHOP_A, generationType: "LIFESTYLE" });

    const job1 = await createGenerationJob({
      shop: SHOP_A,
      productId: rowA.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
      batchId: batch1.id,
    });
    const job2 = await createGenerationJob({
      shop: SHOP_A,
      productId: rowB.id,
      type: "LIFESTYLE",
      sourceMediaIds: ["media-1"],
      plan: plan(),
      batchId: batch1.id,
    });
    // Not part of any batch — a plain single-product generation.
    await createGenerationJob({
      shop: SHOP_A,
      productId: rowA.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    const batch1Jobs = await listGenerationJobsForBatch(SHOP_A, batch1.id);
    expect(batch1Jobs.map((j) => j.id).sort()).toEqual([job1.id, job2.id].sort());

    const batch2Jobs = await listGenerationJobsForBatch(SHOP_A, batch2.id);
    expect(batch2Jobs).toHaveLength(0);

    const loadedJob1 = await getGenerationJob(CONTEXT_A, job1.id);
    expect(loadedJob1?.batchId).toBe(batch1.id);
  });
});

describe("tenant isolation", () => {
  it("getGenerationJob throws TenantMismatchError rather than returning another shop's job", async () => {
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/1");
    const jobB = await createGenerationJob({
      shop: SHOP_B,
      productId: rowB.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    await expect(getGenerationJob(CONTEXT_A, jobB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a generation job id that doesn't exist", async () => {
    expect(await getGenerationJob(CONTEXT_A, "does-not-exist")).toBeNull();
  });

  it("listGenerationJobsForProduct never returns another shop's jobs", async () => {
    const rowA = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/2");
    await createGenerationJob({
      shop: SHOP_B,
      productId: rowB.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });

    const historyA = await listGenerationJobsForProduct(CONTEXT_A, rowA.id);
    expect(historyA).toHaveLength(0);
  });

  it("deleting the underlying product cascades to its generation jobs and results", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "PRODUCT_CLEANUP",
      sourceMediaIds: ["media-1"],
      plan: plan(),
    });
    await createResults(SHOP_A, job.id, [
      {
        storageKey: "k",
        url: null,
        width: null,
        height: null,
        format: null,
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);

    await prisma.shopifyProduct.delete({ where: { id: row.id } });

    expect(await prisma.generationJob.findMany({ where: { productId: row.id } })).toHaveLength(0);
    expect(await prisma.generationResult.findMany({ where: { generationJobId: job.id } })).toHaveLength(0);
  });
});
