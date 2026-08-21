/**
 * Integration test for app/routes/app.store-visuals._index.tsx (create) and
 * app/routes/app.store-visuals.$jobId.tsx (review/regenerate) — the route
 * layer of the route → service → provider → storage → persistence → UI
 * chain. Mirrors tests/integration/routes/app.products.id-model-shoot-action.test.ts's
 * pattern — see that file's doc comment for the E2E auth-bypass seam
 * reasoning.
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

const SHOP_A = "route-store-visuals-a.myshopify.com";

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
    media: [
      {
        shopifyMediaId: `${id}-media-1`,
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

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/store-visuals", { headers: { "x-ai-imageshoot-e2e-shop": shop } });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP_A } });
  await prisma.storeVisualJob.deleteMany({ where: { shop: SHOP_A } });
}

let worker: Worker | undefined;
let newLoader: typeof import("../../../app/routes/app.store-visuals._index").loader;
let newAction: typeof import("../../../app/routes/app.store-visuals._index").action;
let detailLoader: typeof import("../../../app/routes/app.store-visuals.$jobId").loader;
let detailAction: typeof import("../../../app/routes/app.store-visuals.$jobId").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ loader: newLoader, action: newAction } = await import("../../../app/routes/app.store-visuals._index"));
  ({ loader: detailLoader, action: detailAction } = await import("../../../app/routes/app.store-visuals.$jobId"));
  const { processStoreVisualJob } = await import("../../../services/store-visuals/job.server");
  worker = createWorker<StoreVisualJobPayload>("store-visuals", processStoreVisualJob);
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

async function callNewLoader(shop: string) {
  return newLoader({ request: requestFor(shop), params: {}, context: {} } as unknown as Parameters<typeof newLoader>[0]);
}

async function callNewAction(shop: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/store-visuals", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
  return newAction({ request, params: {}, context: {} } as unknown as Parameters<typeof newAction>[0]);
}

async function callDetailLoader(shop: string, jobId: string) {
  return detailLoader({
    request: requestFor(shop),
    params: { jobId },
    context: {},
  } as unknown as Parameters<typeof detailLoader>[0]);
}

async function callDetailAction(shop: string, jobId: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/store-visuals/x", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
  return detailAction({ request, params: { jobId }, context: {} } as unknown as Parameters<typeof detailAction>[0]);
}

function waitForStatus(shop: string, jobId: string, status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callDetailLoader(shop, jobId);
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

describe("app.store-visuals — loader", () => {
  it("returns available presets and a product page", async () => {
    const result = await callNewLoader(SHOP_A);
    expect(result.availableBrandStylePresets.length).toBeGreaterThan(0);
    expect(result.productPage.products).toEqual([]);
  });
});

describe("app.store-visuals — create action", () => {
  it(
    "creates a store visual with no products and redirects to its detail page",
    async () => {
      const actionResult = await callNewAction(SHOP_A, { visualType: "HOMEPAGE_HERO", productIds: "[]" });
      expect(actionResult).toBeInstanceOf(Response);
      expect((actionResult as Response).status).toBe(302);
      const location = (actionResult as Response).headers.get("Location")!;
      expect(location).toMatch(/^\/app\/store-visuals\//);

      const jobId = location.replace("/app/store-visuals/", "");
      await waitForStatus(SHOP_A, jobId, "SUCCEEDED");
      const detail = await callDetailLoader(SHOP_A, jobId);
      expect(detail.job.status).toBe("SUCCEEDED");
      expect(detail.job.results[0].reviewStatus).toBe("PENDING");
    },
    15000,
  );

  it("rejects an unknown visual type", async () => {
    const result = await callNewAction(SHOP_A, { visualType: "NOT_A_REAL_TYPE", productIds: "[]" });
    expect(result).toEqual({ ok: false, error: 'Unknown store visual type "NOT_A_REAL_TYPE".' });
  });

  it("rejects a product id belonging to another shop as a merchant-safe error, not a 404", async () => {
    await upsertSyncedProduct("route-store-visuals-other.myshopify.com", product("gid://shopify/Product/1"));
    const otherRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: "route-store-visuals-other.myshopify.com" } });

    const result = await callNewAction(SHOP_A, { visualType: "STORE_CTA", productIds: JSON.stringify([otherRow.id]) });
    expect(result).toEqual({ ok: false, error: "One of the selected products could not be found. Please try again." });

    await prisma.shopifyProduct.deleteMany({ where: { shop: "route-store-visuals-other.myshopify.com" } });
  });
});

describe("app.store-visuals.$jobId — review and regenerate", () => {
  it(
    "approves a result, and regenerate creates a new independent job",
    async () => {
      const createResult = await callNewAction(SHOP_A, { visualType: "STORE_CTA", productIds: "[]" });
      const firstJobId = (createResult as Response).headers.get("Location")!.replace("/app/store-visuals/", "");
      await waitForStatus(SHOP_A, firstJobId, "SUCCEEDED");

      const before = await callDetailLoader(SHOP_A, firstJobId);
      const resultId = before.job.results[0].id;

      const reviewResult = await callDetailAction(SHOP_A, firstJobId, { intent: "review", resultId, decision: "APPROVED" });
      expect(reviewResult).toEqual({ ok: true });

      const regenerateResult = await callDetailAction(SHOP_A, firstJobId, { intent: "regenerate" });
      expect(regenerateResult).toMatchObject({ ok: true });
      const secondJobId = (regenerateResult as { ok: true; jobId: string }).jobId;
      expect(secondJobId).not.toBe(firstJobId);

      await waitForStatus(SHOP_A, secondJobId, "SUCCEEDED");

      // The original, approved result is untouched by the new request.
      const stillApproved = await callDetailLoader(SHOP_A, firstJobId);
      expect(stillApproved.job.results[0].reviewStatus).toBe("APPROVED");
    },
    20000,
  );

  it("throws a safe 404 for a job belonging to another shop", async () => {
    const createResult = await callNewAction(SHOP_A, { visualType: "STORE_CTA", productIds: "[]" });
    const jobId = (createResult as Response).headers.get("Location")!.replace("/app/store-visuals/", "");

    let caught: unknown;
    try {
      await callDetailLoader("route-store-visuals-b.myshopify.com", jobId);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });
});
