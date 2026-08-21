/**
 * Integration test for app/routes/app.store-visuals.$jobId.tsx's
 * "request-publish" action, and app/routes/app.publishing.tsx's loader
 * (shop-wide publish history). Doesn't run a "publishing" worker — see
 * tests/integration/publishing/publishing-queue.test.ts for the full
 * pipeline with the Shopify boundary mocked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { SyncedProduct } from "../../../services/products/types";
import type { StoreVisualJobPayload } from "../../../services/store-visuals/job.server";

const SHOP = "route-store-visuals-publish-test.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Leather Tote",
    handle: "leather-tote",
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

function requestFor(shop: string, url = "https://example.com/app/store-visuals/x"): Request {
  return new Request(url, { headers: { "x-ai-imageshoot-e2e-shop": shop } });
}

async function cleanup() {
  await prisma.publishingJob.deleteMany({ where: { shop: SHOP } });
  await prisma.storeVisualJob.deleteMany({ where: { shop: SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let newAction: typeof import("../../../app/routes/app.store-visuals._index").action;
let detailLoader: typeof import("../../../app/routes/app.store-visuals.$jobId").loader;
let detailAction: typeof import("../../../app/routes/app.store-visuals.$jobId").action;
let publishingLoader: typeof import("../../../app/routes/app.publishing").loader;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ action: newAction } = await import("../../../app/routes/app.store-visuals._index"));
  ({ loader: detailLoader, action: detailAction } = await import("../../../app/routes/app.store-visuals.$jobId"));
  ({ loader: publishingLoader } = await import("../../../app/routes/app.publishing"));
  const { processStoreVisualJob } = await import("../../../services/store-visuals/job.server");
  worker = createWorker<StoreVisualJobPayload>("store-visuals", processStoreVisualJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();

  // STORE_VISUAL_GENERATION is plan-gated (FREE doesn't include it —
  // see services/billing/plans.ts); this suite exercises publishing, not
  // billing, so the shop needs a plan that does.
  await prisma.shopSubscription.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, planId: "STARTER", status: "ACTIVE" },
    update: { planId: "STARTER", status: "ACTIVE" },
  });
});
afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});
afterAll(async () => {
  await cleanup();
  await prisma.shopSubscription.deleteMany({ where: { shop: SHOP } });
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

async function callNewAction(body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/store-visuals", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": SHOP },
    body: formData,
  });
  return newAction({ request, params: {}, context: {} } as unknown as Parameters<typeof newAction>[0]);
}

async function callDetailLoader(jobId: string) {
  return detailLoader({ request: requestFor(SHOP), params: { jobId }, context: {} } as unknown as Parameters<typeof detailLoader>[0]);
}

async function callDetailAction(jobId: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/store-visuals/x", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": SHOP },
    body: formData,
  });
  return detailAction({ request, params: { jobId }, context: {} } as unknown as Parameters<typeof detailAction>[0]);
}

function waitForStatus(jobId: string, status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callDetailLoader(jobId);
      if (result.job.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${result.job.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.store-visuals.$jobId — request-publish action", () => {
  it(
    "creates a real QUEUED PublishingJob for an approved store visual result, and it shows up in publish history",
    async () => {
      await upsertSyncedProduct(SHOP, product("gid://shopify/Product/1"));
      const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });

      const createResult = await callNewAction({
        visualType: "HOMEPAGE_HERO",
        productIds: JSON.stringify([productRow.id]),
      });
      const jobId = (createResult as Response).headers.get("Location")!.replace("/app/store-visuals/", "");
      await waitForStatus(jobId, "SUCCEEDED");

      const detail = await callDetailLoader(jobId);
      const resultId = detail.job.results[0].id;
      await callDetailAction(jobId, { intent: "review", resultId, decision: "APPROVED" });

      const publishResult = await callDetailAction(jobId, {
        intent: "request-publish",
        sourceResultId: resultId,
        targetProductId: productRow.id,
      });
      expect(publishResult).toEqual({ ok: true });

      const publishingJob = await prisma.publishingJob.findFirstOrThrow({ where: { shop: SHOP, sourceResultId: resultId } });
      expect(publishingJob.status).toBe("QUEUED");
      expect(publishingJob.sourceType).toBe("STORE_VISUAL_RESULT");

      const history = await publishingLoader({
        request: requestFor(SHOP, "https://example.com/app/publishing"),
        params: {},
        context: {},
      } as unknown as Parameters<typeof publishingLoader>[0]);
      expect(history.history.jobs.some((j) => j.id === publishingJob.id)).toBe(true);
    },
    15000,
  );

  it("rejects publishing a store visual with no products at all (no valid target)", async () => {
    const createResult = await callNewAction({ visualType: "STORE_CTA", productIds: "[]" });
    const jobId = (createResult as Response).headers.get("Location")!.replace("/app/store-visuals/", "");
    await waitForStatus(jobId, "SUCCEEDED");

    const detail = await callDetailLoader(jobId);
    const resultId = detail.job.results[0].id;
    await callDetailAction(jobId, { intent: "review", resultId, decision: "APPROVED" });

    const publishResult = await callDetailAction(jobId, {
      intent: "request-publish",
      sourceResultId: resultId,
      targetProductId: "not-a-real-product-id",
    });
    expect(publishResult).toEqual({
      ok: false,
      error: "The selected product isn't a valid publish target for this result.",
    });
  });
});
