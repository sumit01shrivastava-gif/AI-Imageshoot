/**
 * Integration tests: services/publishing/request-publish.server.ts —
 * approval-required validation, target-product validation, and
 * double-publish prevention. Against real local Postgres; the actual
 * Shopify GraphQL call only happens in the WORKER
 * (services/publishing/job.server.ts, covered separately by
 * tests/integration/publishing/publishing-queue.test.ts with the
 * Shopify boundary mocked) — `requestPublish` itself only creates +
 * enqueues, so no Shopify call happens here at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { createGenerationJob, createResults as createGenerationResults, setGenerationResultReviewStatus } from "../../../db/repositories/generation-job.repository";
import { markSucceeded as markPublishingSucceeded } from "../../../db/repositories/publishing-job.repository";
import { parseGenerationPlan } from "../../../services/generation/schema";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP = "request-publish-test.myshopify.com";
const OTHER_SHOP = "request-publish-test-other.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

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

function generationPlan() {
  return parseGenerationPlan({
    generationType: "PRODUCT_CLEANUP",
    assetType: "product_studio",
    category: "Handbags",
    sourceProductId: "product-1",
    sourceImages: [{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 }],
    productFacts: { identityAnchors: null },
    creativeDirection: { prompt: "Clean product photography.", negativeConstraints: [], environment: null, lighting: null, composition: null },
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

async function seedGenerationResult(shop: string, productId: string, reviewStatus: "PENDING" | "APPROVED" | "REJECTED" = "PENDING") {
  const job = await createGenerationJob({ shop, productId, type: "PRODUCT_CLEANUP", sourceMediaIds: [], plan: generationPlan() });
  await createGenerationResults(shop, job.id, [
    {
      storageKey: `shops/${shop}/generation/${job.id}/0.png`,
      url: null,
      width: 1024,
      height: 1024,
      format: "png",
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    },
  ]);
  const result = await prisma.generationResult.findFirstOrThrow({ where: { generationJobId: job.id } });
  if (reviewStatus !== "PENDING") {
    await setGenerationResultReviewStatus({ shop, sessionId: "s1", isOnline: false }, result.id, reviewStatus);
  }
  return result;
}

async function cleanup() {
  await prisma.publishingJob.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await prisma.generationJob.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
}

let requestPublish: typeof import("../../../services/publishing/request-publish.server").requestPublish;
let ResultNotApprovedError: typeof import("../../../services/publishing/request-publish.server").ResultNotApprovedError;
let InvalidPublishTargetError: typeof import("../../../services/publishing/request-publish.server").InvalidPublishTargetError;
let PublishSourceNotFoundError: typeof import("../../../services/publishing/request-publish.server").PublishSourceNotFoundError;
let AlreadyPublishedError: typeof import("../../../services/publishing/request-publish.server").AlreadyPublishedError;
let PublishInProgressError: typeof import("../../../services/publishing/request-publish.server").PublishInProgressError;
let InvalidPublishRequestError: typeof import("../../../services/publishing/request-publish.server").InvalidPublishRequestError;

beforeAll(async () => {
  resetEnvCacheForTests();
  ({
    requestPublish,
    ResultNotApprovedError,
    InvalidPublishTargetError,
    PublishSourceNotFoundError,
    AlreadyPublishedError,
    PublishInProgressError,
    InvalidPublishRequestError,
  } = await import("../../../services/publishing/request-publish.server"));
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("requestPublish — validation", () => {
  it("rejects an unknown sourceType", async () => {
    await expect(
      requestPublish(CONTEXT, { sourceType: "NOT_REAL", sourceResultId: "x", targetProductId: "y" }),
    ).rejects.toThrow(InvalidPublishRequestError);
  });

  it("throws PublishSourceNotFoundError for a result id that doesn't exist", async () => {
    const productRow = await (async () => {
      await upsertSyncedProduct(SHOP, product("product-1"));
      return prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });
    })();

    await expect(
      requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: "does-not-exist", targetProductId: productRow.id }),
    ).rejects.toThrow(PublishSourceNotFoundError);
  });

  it("throws ResultNotApprovedError for a PENDING (not yet approved) result", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });
    const result = await seedGenerationResult(SHOP, productRow.id, "PENDING");

    await expect(
      requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: result.id, targetProductId: productRow.id }),
    ).rejects.toThrow(ResultNotApprovedError);
  });

  it("throws ResultNotApprovedError for a REJECTED result", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });
    const result = await seedGenerationResult(SHOP, productRow.id, "REJECTED");

    await expect(
      requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: result.id, targetProductId: productRow.id }),
    ).rejects.toThrow(ResultNotApprovedError);
  });

  it("throws InvalidPublishTargetError when the target product isn't a valid candidate for this result", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    await upsertSyncedProduct(SHOP, product("product-2"));
    const [productA, productB] = await Promise.all([
      prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId: "product-1" } }),
      prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId: "product-2" } }),
    ]);
    const result = await seedGenerationResult(SHOP, productA.id, "APPROVED");

    await expect(
      requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: result.id, targetProductId: productB.id }),
    ).rejects.toThrow(InvalidPublishTargetError);
  });

  it("succeeds for an APPROVED result published to its own owning product", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });
    const result = await seedGenerationResult(SHOP, productRow.id, "APPROVED");

    const job = await requestPublish(CONTEXT, {
      sourceType: "GENERATION_RESULT",
      sourceResultId: result.id,
      targetProductId: productRow.id,
    });
    expect(job.id).toBeTruthy();

    const row = await prisma.publishingJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe("QUEUED");
  });

  it("never resolves another shop's result (tenant isolation)", async () => {
    await upsertSyncedProduct(OTHER_SHOP, product("other-product-1"));
    const otherProductRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: OTHER_SHOP } });
    const otherResult = await seedGenerationResult(OTHER_SHOP, otherProductRow.id, "APPROVED");

    await expect(
      requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: otherResult.id, targetProductId: otherProductRow.id }),
    ).rejects.toThrow(PublishSourceNotFoundError);
  });
});

describe("requestPublish — double-publish prevention", () => {
  it("throws AlreadyPublishedError when the latest job for this source already SUCCEEDED", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });
    const result = await seedGenerationResult(SHOP, productRow.id, "APPROVED");

    const firstJob = await requestPublish(CONTEXT, {
      sourceType: "GENERATION_RESULT",
      sourceResultId: result.id,
      targetProductId: productRow.id,
    });
    await markPublishingSucceeded(SHOP, firstJob.id, { shopifyMediaId: "gid://shopify/MediaImage/1", durationMs: 10 });

    await expect(
      requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: result.id, targetProductId: productRow.id }),
    ).rejects.toThrow(AlreadyPublishedError);
  });

  it("throws PublishInProgressError when a job is already PENDING/QUEUED/PROCESSING for this source", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });
    const result = await seedGenerationResult(SHOP, productRow.id, "APPROVED");

    await requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: result.id, targetProductId: productRow.id });

    await expect(
      requestPublish(CONTEXT, { sourceType: "GENERATION_RESULT", sourceResultId: result.id, targetProductId: productRow.id }),
    ).rejects.toThrow(PublishInProgressError);
  });
});
