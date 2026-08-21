/**
 * Integration tests: services/assets/asset-library.server.ts — the
 * cross-domain merge/filter/pagination of GenerationResult/
 * ProcessingResult/StoreVisualResult into one shop-wide, newest-first
 * list. Against a real local Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import {
  createGenerationJob,
  createResults as createGenerationResults,
  setGenerationResultReviewStatus,
} from "../../../db/repositories/generation-job.repository";
import { createProcessingJob, createResult as createProcessingResult } from "../../../db/repositories/processing-job.repository";
import { createStoreVisualJob, createResults as createStoreVisualResults } from "../../../db/repositories/store-visual-job.repository";
import { parseGenerationPlan } from "../../../services/generation/schema";
import { parseStoreVisualPlan } from "../../../services/store-visuals/schema";
import { listAssetLibrary } from "../../../services/assets/asset-library.server";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP = "asset-library-test.myshopify.com";
const OTHER_SHOP = "asset-library-test-other.myshopify.com";
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

async function seedProduct(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  return prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId }, include: { media: true } });
}

async function seedGenerationResult(shop: string, productId: string) {
  const job = await createGenerationJob({ shop, productId, type: "LIFESTYLE", sourceMediaIds: [], plan: generationPlan() });
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
  return job;
}

async function seedProcessingResult(shop: string, productId: string, sourceMediaId: string) {
  const job = await createProcessingJob({
    shop,
    productId,
    sourceMediaId,
    operation: "REMOVE_BACKGROUND",
    options: {},
    identityAnchors: null,
  });
  await createProcessingResult(shop, job.id, {
    storageKey: `shops/${shop}/processing/${job.id}/0.png`,
    url: null,
    width: 1024,
    height: 1024,
    format: "png",
    providerName: "deterministic-test",
    providerResultId: null,
    metadata: null,
  });
  return job;
}

async function seedStoreVisualResult(shop: string) {
  const job = await createStoreVisualJob({ shop, type: "HOMEPAGE_HERO", plan: storeVisualPlan(), productIds: [] });
  await createStoreVisualResults(shop, job.id, [
    {
      storageKey: `shops/${shop}/store-visuals/${job.id}/0.png`,
      url: null,
      width: 1920,
      height: 823,
      format: "png",
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    },
  ]);
  return job;
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await prisma.generationJob.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await prisma.processingJob.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await prisma.storeVisualJob.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
}

beforeAll(cleanup);
afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("listAssetLibrary", () => {
  it("merges all three domains, newest first, with fresh-signed URLs", async () => {
    const productRow = await seedProduct(SHOP, "product-1");
    await seedGenerationResult(SHOP, productRow.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedProcessingResult(SHOP, productRow.id, productRow.media[0].id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await seedStoreVisualResult(SHOP);

    const page = await listAssetLibrary(CONTEXT, {}, 1);
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(3);
    // Newest first: store visual (last created) leads.
    expect(page.items[0].kind).toBe("STORE_VISUAL");
    expect(page.items[1].kind).toBe("PROCESSING");
    expect(page.items[2].kind).toBe("GENERATION");
    // Every item's url is a freshly-signed one, never the stored `null`.
    for (const item of page.items) {
      expect(item.url).toBeTruthy();
    }
  });

  it("never leaks storageKey on the returned item", async () => {
    const productRow = await seedProduct(SHOP, "product-1");
    await seedGenerationResult(SHOP, productRow.id);
    const page = await listAssetLibrary(CONTEXT, {}, 1);
    expect(page.items[0]).not.toHaveProperty("storageKey");
  });

  it("filters by kind — exact single-table pagination", async () => {
    const productRow = await seedProduct(SHOP, "product-1");
    await seedGenerationResult(SHOP, productRow.id);
    await seedProcessingResult(SHOP, productRow.id, productRow.media[0].id);
    await seedStoreVisualResult(SHOP);

    const generationOnly = await listAssetLibrary(CONTEXT, { kind: "GENERATION" }, 1);
    expect(generationOnly.total).toBe(1);
    expect(generationOnly.items.every((item) => item.kind === "GENERATION")).toBe(true);

    const storeVisualOnly = await listAssetLibrary(CONTEXT, { kind: "STORE_VISUAL" }, 1);
    expect(storeVisualOnly.total).toBe(1);
    expect(storeVisualOnly.items[0].scope).toBe("STORE");
  });

  it("filters by review status", async () => {
    const productRow = await seedProduct(SHOP, "product-1");
    const job = await seedGenerationResult(SHOP, productRow.id);
    const loaded = await prisma.generationResult.findFirstOrThrow({ where: { generationJobId: job.id } });
    await setGenerationResultReviewStatus(CONTEXT, loaded.id, "APPROVED");
    await seedProcessingResult(SHOP, productRow.id, productRow.media[0].id);

    const approvedOnly = await listAssetLibrary(CONTEXT, { status: "APPROVED" }, 1);
    expect(approvedOnly.total).toBe(1);
    expect(approvedOnly.items[0].reviewStatus).toBe("APPROVED");

    const pendingOnly = await listAssetLibrary(CONTEXT, { status: "PENDING" }, 1);
    expect(pendingOnly.total).toBe(1);
  });

  it("never returns another shop's assets", async () => {
    const otherProduct = await seedProduct(OTHER_SHOP, "other-product-1");
    await seedGenerationResult(OTHER_SHOP, otherProduct.id);
    await seedStoreVisualResult(OTHER_SHOP);

    const page = await listAssetLibrary(CONTEXT, {}, 1);
    expect(page.total).toBe(0);
    expect(page.items).toHaveLength(0);
  });

  it("paginates within a bounded page size", async () => {
    const productRow = await seedProduct(SHOP, "product-1");
    for (let i = 0; i < 5; i += 1) {
      await seedGenerationResult(SHOP, productRow.id);
    }

    const page1 = await listAssetLibrary(CONTEXT, {}, 1, 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await listAssetLibrary(CONTEXT, {}, 2, 2);
    expect(page2.items).toHaveLength(2);

    const page3 = await listAssetLibrary(CONTEXT, {}, 3, 2);
    expect(page3.items).toHaveLength(1);
  });

  it("clamps an invalid page number to 1 rather than erroring", async () => {
    const productRow = await seedProduct(SHOP, "product-1");
    await seedGenerationResult(SHOP, productRow.id);
    const page = await listAssetLibrary(CONTEXT, {}, -3);
    expect(page.page).toBe(1);
    expect(page.items.length).toBeGreaterThan(0);
  });
});
