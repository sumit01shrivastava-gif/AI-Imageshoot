/**
 * Integration test: publishing through the real `"publishing"` queue end
 * to end — a real BullMQ worker, real Postgres, real
 * requestPublish/job.server.ts pipeline. The ONE thing mocked is
 * services/shopify/publish-media.server.ts's `publishMediaToProduct` —
 * the actual outbound call to Shopify's servers, which this environment
 * has no live session/write scope to reach (see CLAUDE.md "Never call a
 * live/production Shopify store... from automated tests"). This mirrors
 * exactly how services/generation/deterministic-test-provider.server.ts
 * stands in for a real AI vendor in generation's own queue tests — a
 * domain-owned test double for the one genuinely-external call, with
 * everything else (queue, worker, retry, persistence) real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import {
  createGenerationJob,
  createResults as createGenerationResults,
  setGenerationResultReviewStatus,
} from "../../../db/repositories/generation-job.repository";
import { parseGenerationPlan } from "../../../services/generation/schema";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { PublishingJobPayload } from "../../../services/publishing/job.server";

const SHOP = "publish-queue-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

const publishMediaToProductMock = vi.fn();
vi.mock("../../../services/shopify/publish-media.server", async () => {
  const actual = await vi.importActual<typeof import("../../../services/shopify/publish-media.server")>(
    "../../../services/shopify/publish-media.server",
  );
  return {
    ...actual,
    publishMediaToProduct: (...args: unknown[]) => publishMediaToProductMock(...args),
  };
});

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

async function seedApprovedResult(suffix: string) {
  await upsertSyncedProduct(SHOP, product(`product-${suffix}`));
  const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId: `product-${suffix}` } });
  const job = await createGenerationJob({ shop: SHOP, productId: productRow.id, type: "PRODUCT_CLEANUP", sourceMediaIds: [], plan: generationPlan() });
  await createGenerationResults(SHOP, job.id, [
    {
      storageKey: `shops/${SHOP}/generation/${job.id}/0.png`,
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
  await setGenerationResultReviewStatus(CONTEXT, result.id, "APPROVED");
  return { productRow, result };
}

async function cleanup() {
  await prisma.publishingJob.deleteMany({ where: { shop: SHOP } });
  await prisma.generationJob.deleteMany({ where: { shop: SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let requestPublish: typeof import("../../../services/publishing/request-publish.server").requestPublish;
let getPublishing: typeof import("../../../services/publishing/request-publish.server").getPublishing;

beforeAll(async () => {
  resetEnvCacheForTests();
  ({ requestPublish, getPublishing } = await import("../../../services/publishing/request-publish.server"));
  const { processPublishingJob } = await import("../../../services/publishing/job.server");

  worker = createWorker<PublishingJobPayload>("publishing", processPublishingJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();
});
afterEach(async () => {
  await cleanup();
  publishMediaToProductMock.mockReset();
});
afterAll(async () => {
  await cleanup();
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
});

function waitForStatus(id: string, status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const job = await getPublishing(CONTEXT, id);
      if (job?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${job?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("publishing queue — success", () => {
  it("publishes an approved result and records the resulting Shopify media id", async () => {
    publishMediaToProductMock.mockResolvedValue({ shopifyMediaId: "gid://shopify/MediaImage/555" });
    const { productRow, result } = await seedApprovedResult("1");

    const job = await requestPublish(CONTEXT, {
      sourceType: "GENERATION_RESULT",
      sourceResultId: result.id,
      targetProductId: productRow.id,
    });

    await waitForStatus(job.id, "SUCCEEDED");
    const row = await getPublishing(CONTEXT, job.id);
    expect(row!.shopifyMediaId).toBe("gid://shopify/MediaImage/555");
    expect(publishMediaToProductMock).toHaveBeenCalledTimes(1);
    // The image url handed to Shopify is a real, freshly-signed url —
    // never the raw storageKey.
    const call = publishMediaToProductMock.mock.calls[0][1];
    expect(call.imageUrl).toMatch(/^\/media\//);
  });
});

describe("publishing queue — permission failure skips retries", () => {
  it("goes straight to FAILED (not retried through all 3 attempts) on a permission-shaped error", async () => {
    const { ShopifyPublishError } = await import("../../../services/shopify/publish-media.server");
    publishMediaToProductMock.mockRejectedValue(new ShopifyPublishError("Access denied", { isPermissionError: true }));
    const { productRow, result } = await seedApprovedResult("2");

    const job = await requestPublish(CONTEXT, {
      sourceType: "GENERATION_RESULT",
      sourceResultId: result.id,
      targetProductId: productRow.id,
    });

    await waitForStatus(job.id, "FAILED");
    // Give any (incorrect) retry a moment to have fired if the
    // UnrecoverableError classification were broken.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(publishMediaToProductMock).toHaveBeenCalledTimes(1);

    const row = await getPublishing(CONTEXT, job.id);
    expect(row!.errorMessage).toMatch(/permission/i);
  });
});

describe("publishing queue — idempotency", () => {
  it("never calls Shopify twice for the same already-SUCCEEDED job", async () => {
    publishMediaToProductMock.mockResolvedValue({ shopifyMediaId: "gid://shopify/MediaImage/777" });
    const { productRow, result } = await seedApprovedResult("3");

    const job = await requestPublish(CONTEXT, {
      sourceType: "GENERATION_RESULT",
      sourceResultId: result.id,
      targetProductId: productRow.id,
    });
    await waitForStatus(job.id, "SUCCEEDED");
    expect(publishMediaToProductMock).toHaveBeenCalledTimes(1);

    const { enqueuePublishingJob } = await import("../../../services/publishing/queue.server");
    await enqueuePublishingJob({ shop: SHOP, publishingJobId: job.id });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(publishMediaToProductMock).toHaveBeenCalledTimes(1);
  });
});
