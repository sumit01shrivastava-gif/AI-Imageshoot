/**
 * Integration test for app/routes/app.assets.tsx's loader — the route
 * layer over services/assets/asset-library.server.ts. Mirrors
 * tests/integration/routes/app.store-visuals-action.test.ts's pattern.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { createGenerationJob, createResults as createGenerationResults } from "../../../db/repositories/generation-job.repository";
import { createStoreVisualJob, createResults as createStoreVisualResults } from "../../../db/repositories/store-visual-job.repository";
import { parseGenerationPlan } from "../../../services/generation/schema";
import { parseStoreVisualPlan } from "../../../services/store-visuals/schema";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP = "route-assets-test.myshopify.com";

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
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

function generationPlan() {
  return parseGenerationPlan({
    generationType: "LIFESTYLE",
    assetType: "lifestyle",
    category: "Handbags",
    sourceProductId: "product-1",
    sourceImages: [{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 }],
    productFacts: { identityAnchors: null },
    creativeDirection: { prompt: "A lifestyle scene.", negativeConstraints: [], environment: null, lighting: null, composition: null },
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

function storeVisualPlan() {
  return parseStoreVisualPlan({
    visualType: "HOMEPAGE_HERO",
    products: [],
    creativeDirection: { prompt: "A homepage hero.", negativeConstraints: [] },
    aspectRatio: "21:9",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    brandStyle: null,
    constraints: [],
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.generationJob.deleteMany({ where: { shop: SHOP } });
  await prisma.storeVisualJob.deleteMany({ where: { shop: SHOP } });
}

let loader: typeof import("../../../app/routes/app.assets").loader;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  resetEnvCacheForTests();
  ({ loader } = await import("../../../app/routes/app.assets"));
  await cleanup();
});
afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function requestFor(url: string): Request {
  return new Request(url, { headers: { "x-ai-imageshoot-e2e-shop": SHOP } });
}

async function callLoader(url: string) {
  return loader({ request: requestFor(url), params: {}, context: {} } as unknown as Parameters<typeof loader>[0]);
}

describe("app.assets — loader", () => {
  it("returns an empty page for a shop with nothing yet", async () => {
    const result = await callLoader("https://example.com/app/assets");
    expect(result.result.items).toHaveLength(0);
    expect(result.result.total).toBe(0);
  });

  it("merges generation and store-visual results, newest first", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });

    const genJob = await createGenerationJob({
      shop: SHOP,
      productId: productRow.id,
      type: "LIFESTYLE",
      sourceMediaIds: [],
      plan: generationPlan(),
    });
    await createGenerationResults(SHOP, genJob.id, [
      {
        storageKey: `shops/${SHOP}/generation/${genJob.id}/0.png`,
        url: null,
        width: 1024,
        height: 1024,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);

    const storeJob = await createStoreVisualJob({ shop: SHOP, type: "HOMEPAGE_HERO", plan: storeVisualPlan(), productIds: [] });
    await createStoreVisualResults(SHOP, storeJob.id, [
      {
        storageKey: `shops/${SHOP}/store-visuals/${storeJob.id}/0.png`,
        url: null,
        width: 1920,
        height: 823,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);

    const result = await callLoader("https://example.com/app/assets");
    expect(result.result.total).toBe(2);
    expect(result.result.items[0].kind).toBe("STORE_VISUAL");
    expect(result.result.items[1].kind).toBe("GENERATION");
  });

  it("respects an invalid kind query param by ignoring it (no filter, not a crash)", async () => {
    const result = await callLoader("https://example.com/app/assets?kind=NOT_REAL");
    expect(result.kind).toBe("");
    expect(result.result.total).toBe(0);
  });

  it("applies a valid kind filter from the query string", async () => {
    await upsertSyncedProduct(SHOP, product("product-1"));
    const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP } });
    const genJob = await createGenerationJob({
      shop: SHOP,
      productId: productRow.id,
      type: "LIFESTYLE",
      sourceMediaIds: [],
      plan: generationPlan(),
    });
    await createGenerationResults(SHOP, genJob.id, [
      {
        storageKey: `shops/${SHOP}/generation/${genJob.id}/0.png`,
        url: null,
        width: 1024,
        height: 1024,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);
    await createStoreVisualJob({ shop: SHOP, type: "HOMEPAGE_HERO", plan: storeVisualPlan(), productIds: [] });

    const result = await callLoader("https://example.com/app/assets?kind=GENERATION");
    expect(result.kind).toBe("GENERATION");
    expect(result.result.total).toBe(1);
    expect(result.result.items[0].kind).toBe("GENERATION");
  });
});
