/**
 * Integration test for app/routes/app.creative.$sessionId.tsx (loader +
 * action) and app/routes/app.products.$id.tsx's "start-creative-session"
 * entry-point action. Runs a real "generation" worker so "send-message"
 * reaches the real queue — mirrors
 * tests/integration/routes/app.products.id-publish-action.test.ts's
 * established pattern.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { SyncedProduct } from "../../../services/products/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP_A = "route-creative-a.myshopify.com";
const SHOP_B = "route-creative-b.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Studio Tote",
    handle: "studio-tote",
    description: "A handcrafted leather tote.",
    productType: "Handbags",
    category: "Handbags",
    vendor: "Acme",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: `${id}-media-1`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/tote.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio tote",
        position: 0,
      },
    ],
  };
}

async function seedAnalyzed(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio", "lifestyle"],
    identityAnchors: { category: "Handbags", material: "Leather", primaryColor: "Brown" },
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });
  return row;
}

function requestFor(shop: string, url = "https://example.com/app/products/x"): Request {
  return new Request(url, { headers: { "x-ai-imageshoot-e2e-shop": shop } });
}

async function cleanup() {
  for (const shop of [SHOP_A, SHOP_B]) {
    await prisma.creativeMessage.deleteMany({ where: { shop } });
    await prisma.creativeSession.deleteMany({ where: { shop } });
    await prisma.creditReservation.deleteMany({ where: { shop } });
    await prisma.generationJob.deleteMany({ where: { shop } });
    await prisma.shopifyProduct.deleteMany({ where: { shop } });
  }
}

let worker: Worker | undefined;
let productAction: typeof import("../../../app/routes/app.products.$id").action;
let creativeLoader: typeof import("../../../app/routes/app.creative.$sessionId").loader;
let creativeAction: typeof import("../../../app/routes/app.creative.$sessionId").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ action: productAction } = await import("../../../app/routes/app.products.$id"));
  ({ loader: creativeLoader, action: creativeAction } = await import("../../../app/routes/app.creative.$sessionId"));
  const { processGenerationJob } = await import("../../../services/generation/job.server");
  worker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();

  // Requests more than one output in places — the FREE plan's
  // maxOutputsPerGeneration is 1 (services/billing/plans.ts).
  for (const shop of [SHOP_A, SHOP_B]) {
    await prisma.shopSubscription.upsert({
      where: { shop },
      create: { shop, planId: "STARTER", status: "ACTIVE" },
      update: { planId: "STARTER", status: "ACTIVE" },
    });
  }
});
afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});
afterAll(async () => {
  await cleanup();
  await prisma.shopSubscription.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

async function callProductAction(shop: string, id: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/products/x", { method: "POST", headers: { "x-ai-imageshoot-e2e-shop": shop }, body: formData });
  return productAction({ request, params: { id }, context: {} } as unknown as Parameters<typeof productAction>[0]);
}

async function callCreativeLoader(shop: string, sessionId: string) {
  return creativeLoader({ request: requestFor(shop), params: { sessionId }, context: {} } as unknown as Parameters<typeof creativeLoader>[0]);
}

async function callCreativeAction(shop: string, sessionId: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/creative/x", { method: "POST", headers: { "x-ai-imageshoot-e2e-shop": shop }, body: formData });
  return creativeAction({ request, params: { sessionId }, context: {} } as unknown as Parameters<typeof creativeAction>[0]);
}

async function startSession(shop: string, productId: string): Promise<string> {
  const result = await callProductAction(shop, productId, { intent: "start-creative-session" });
  const location = (result as Response).headers.get("Location")!;
  return location.replace("/app/creative/", "");
}

function waitForStatus(shop: string, sessionId: string, status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const detail = await callCreativeLoader(shop, sessionId);
      if (detail.jobs[0]?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${detail.jobs[0]?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.products.$id — start-creative-session action", () => {
  it("creates a session and redirects to /app/creative/:id", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");
    const result = await callProductAction(SHOP_A, row.id, { intent: "start-creative-session" });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toMatch(/^\/app\/creative\//);
  });

  it("404s for another shop's product", async () => {
    const rowB = await seedAnalyzed(SHOP_B, "gid://shopify/Product/2");
    await expect(callProductAction(SHOP_A, rowB.id, { intent: "start-creative-session" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("app.creative.$sessionId — loader", () => {
  it("404s for a session belonging to another shop (tenant isolation)", async () => {
    const rowB = await seedAnalyzed(SHOP_B, "gid://shopify/Product/3");
    const sessionId = await startSession(SHOP_B, rowB.id);
    await expect(callCreativeLoader(SHOP_A, sessionId)).rejects.toMatchObject({ status: 404 });
  });

  it("404s for a session id that doesn't exist at all", async () => {
    await expect(callCreativeLoader(SHOP_A, "not-a-real-session-id")).rejects.toMatchObject({ status: 404 });
  });
});

describe("app.creative.$sessionId — send-message action", () => {
  it(
    "queues a real generation request and the loader reflects the succeeded result",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/4");
      const sessionId = await startSession(SHOP_A, row.id);

      const sendResult = await callCreativeAction(SHOP_A, sessionId, {
        intent: "send-message",
        message: "Put my product in a premium lifestyle scene",
      });
      expect(sendResult).toMatchObject({ ok: true });

      await waitForStatus(SHOP_A, sessionId, "SUCCEEDED");
      const detail = await callCreativeLoader(SHOP_A, sessionId);
      expect(detail.jobs[0].results).toHaveLength(1);
      expect(detail.messages).toHaveLength(2);
    },
    15000,
  );

  it("returns a merchant-safe error for an empty message", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/5");
    const sessionId = await startSession(SHOP_A, row.id);
    const result = await callCreativeAction(SHOP_A, sessionId, { intent: "send-message", message: "   " });
    expect(result).toEqual({ ok: false, error: "Message cannot be empty." });
  });

  it("never lets a merchant send a message into another shop's session", async () => {
    const rowB = await seedAnalyzed(SHOP_B, "gid://shopify/Product/6");
    const sessionIdB = await startSession(SHOP_B, rowB.id);
    await expect(
      callCreativeAction(SHOP_A, sessionIdB, { intent: "send-message", message: "Make it brighter" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("app.creative.$sessionId — select-result action", () => {
  it(
    "updates the session's current result",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/7");
      const sessionId = await startSession(SHOP_A, row.id);
      await callCreativeAction(SHOP_A, sessionId, { intent: "send-message", message: "Create 2 variations" });
      await waitForStatus(SHOP_A, sessionId, "SUCCEEDED");

      const detail = await callCreativeLoader(SHOP_A, sessionId);
      const secondResultId = detail.jobs[0].results[1].id;

      const result = await callCreativeAction(SHOP_A, sessionId, { intent: "select-result", resultId: secondResultId });
      expect(result).toEqual({ ok: true });

      const refreshed = await prisma.creativeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(refreshed.currentResultId).toBe(secondResultId);
    },
    15000,
  );
});
