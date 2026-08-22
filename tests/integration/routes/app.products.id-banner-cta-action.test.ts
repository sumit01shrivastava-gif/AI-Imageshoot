/**
 * Integration test for app/routes/app.products.$id.tsx's "AI Product
 * Imagery" section's BANNER/CTA case — the "generate-product-imagery"
 * action with `generationType: "BANNER"`/`"CTA"`. LIFESTYLE is covered by
 * app.products.id-lifestyle-generation-action.test.ts, MODEL_SHOOT by
 * app.products.id-model-shoot-action.test.ts.
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

const SHOP_A = "route-banner-cta-a.myshopify.com";

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

async function seedAnalyzed(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio"],
    identityAnchors: { category: "Handbags", material: "Leather" },
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });
  return row;
}

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/products/x", {
    headers: { "x-ai-imageshoot-e2e-shop": shop },
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP_A } });
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP_A } });
}

let worker: Worker | undefined;
let loader: typeof import("../../../app/routes/app.products.$id").loader;
let action: typeof import("../../../app/routes/app.products.$id").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ loader, action } = await import("../../../app/routes/app.products.$id"));
  const { processGenerationJob } = await import("../../../services/generation/job.server");
  worker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
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

async function callLoader(shop: string, id: string) {
  return loader({
    request: requestFor(shop),
    params: { id },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

async function callAction(shop: string, id: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/products/x", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
  return action({ request, params: { id }, context: {} } as unknown as Parameters<typeof action>[0]);
}

function waitForStatus(shop: string, id: string, type: "BANNER" | "CTA", status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callLoader(shop, id);
      const latest = result.generationHistory.find((job) => job.type === type);
      if (latest?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${latest?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.products.$id — 'generate-product-imagery' action (BANNER)", () => {
  it(
    "queues a BANNER generation, and the loader eventually reflects the completed result",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");

      const actionResult = await callAction(SHOP_A, row.id, {
        intent: "generate-product-imagery",
        generationType: "BANNER",
        presetId: "clean-commercial",
        aspectRatio: "21:9",
      });
      expect(actionResult).toEqual({ ok: true });

      await waitForStatus(SHOP_A, row.id, "BANNER", "SUCCEEDED");

      const result = await callLoader(SHOP_A, row.id);
      const banners = result.generationHistory.filter((job) => job.type === "BANNER");
      expect(banners).toHaveLength(1);
      expect(banners[0].status).toBe("SUCCEEDED");
    },
    15000,
  );

  it("no modelSuitable gate — this product (modelSuitable: false) still gets a banner", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/2");
    const result = await callAction(SHOP_A, row.id, { intent: "generate-product-imagery", generationType: "BANNER" });
    expect(result).toEqual({ ok: true });
  });
});

describe("app.products.$id — 'generate-product-imagery' action (CTA)", () => {
  it(
    "queues a CTA generation, and the loader eventually reflects the completed result",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/3");

      const actionResult = await callAction(SHOP_A, row.id, { intent: "generate-product-imagery", generationType: "CTA" });
      expect(actionResult).toEqual({ ok: true });

      await waitForStatus(SHOP_A, row.id, "CTA", "SUCCEEDED");

      const result = await callLoader(SHOP_A, row.id);
      const ctas = result.generationHistory.filter((job) => job.type === "CTA");
      expect(ctas).toHaveLength(1);
      expect(ctas[0].status).toBe("SUCCEEDED");
    },
    15000,
  );
});
