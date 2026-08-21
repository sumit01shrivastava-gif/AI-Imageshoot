/**
 * Integration test: services/shopify/shop-redaction.server.ts's
 * `redactShopData` — the `shop/redact` GDPR compliance webhook's
 * implementation (see app/routes/webhooks.shop.redact.tsx). Seeds real
 * data across every domain via a real local Postgres, then verifies
 * every row for the target shop is gone and another shop's data is
 * completely untouched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { createGenerationJob, createResults as createGenerationResults } from "../../../db/repositories/generation-job.repository";
import { createGenerationBatch } from "../../../db/repositories/generation-batch.repository";
import { createProcessingJob, createResult as createProcessingResult } from "../../../db/repositories/processing-job.repository";
import { createBatch as createProcessingBatch } from "../../../db/repositories/processing-batch.repository";
import { createStoreVisualJob, createResults as createStoreVisualResults } from "../../../db/repositories/store-visual-job.repository";
import { createBrandStylePreset } from "../../../db/repositories/brand-style-preset.repository";
import { setDefaultBrandStylePreset } from "../../../db/repositories/shop-settings.repository";
import { createImageSelection } from "../../../services/products/selection.server";
import { parseGenerationPlan } from "../../../services/generation/schema";
import { parseStoreVisualPlan } from "../../../services/store-visuals/schema";
import { redactShopData } from "../../../services/shopify/shop-redaction.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP = "redact-test-shop.myshopify.com";
const OTHER_SHOP = "redact-test-other-shop.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };
const OTHER_CONTEXT: AuthContext = { shop: OTHER_SHOP, sessionId: "s1", isOnline: false };

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

/** Seeds one representative row in every shop-scoped table for `shop`. */
async function seedEverything(shop: string, context: AuthContext) {
  await upsertSyncedProduct(shop, product("product-1"));
  const productRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop }, include: { media: true } });

  const genBatch = await createGenerationBatch({ shop, generationType: "LIFESTYLE" });
  const genJob = await createGenerationJob({
    shop,
    productId: productRow.id,
    type: "LIFESTYLE",
    sourceMediaIds: [],
    plan: generationPlan(),
    batchId: genBatch.id,
  });
  await createGenerationResults(shop, genJob.id, [
    {
      storageKey: `shops/${shop}/generation/${genJob.id}/0.png`,
      url: null,
      width: 1024,
      height: 1024,
      format: "png",
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    },
  ]);

  const procBatch = await createProcessingBatch({ shop, operation: "REMOVE_BACKGROUND" });
  const procJob = await createProcessingJob({
    shop,
    productId: productRow.id,
    sourceMediaId: productRow.media[0].id,
    operation: "REMOVE_BACKGROUND",
    options: {},
    identityAnchors: null,
    batchId: procBatch.id,
  });
  await createProcessingResult(shop, procJob.id, {
    storageKey: `shops/${shop}/processing/${procJob.id}/0.png`,
    url: null,
    width: 1024,
    height: 1024,
    format: "png",
    providerName: "deterministic-test",
    providerResultId: null,
    metadata: null,
  });

  const storeJob = await createStoreVisualJob({ shop, type: "HOMEPAGE_HERO", plan: storeVisualPlan(), productIds: [productRow.id] });
  await createStoreVisualResults(shop, storeJob.id, [
    {
      storageKey: `shops/${shop}/store-visuals/${storeJob.id}/0.png`,
      url: null,
      width: 1920,
      height: 823,
      format: "png",
      providerName: "deterministic-test",
      providerResultId: null,
      metadata: null,
    },
  ]);

  const preset = await createBrandStylePreset({ shop, name: "My Look", attributes: { mood: "cozy" } });
  await setDefaultBrandStylePreset(shop, preset.id);

  await createImageSelection(context, [{ productId: productRow.id, productMediaId: productRow.media[0].id }]);

  await prisma.shopSyncState.upsert({
    where: { shop },
    create: { shop, status: "IDLE" },
    update: { status: "IDLE" },
  });

  await prisma.session.create({
    data: { id: `session-${shop}`, shop, state: "state", isOnline: false, accessToken: "token" },
  });

  return { productRow, genJob, procJob, storeJob, preset };
}

async function cleanup() {
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.storeVisualResult.deleteMany({ where: { shop } });
    await prisma.storeVisualJobProduct.deleteMany({ where: { storeVisualJob: { shop } } });
    await prisma.storeVisualJob.deleteMany({ where: { shop } });
    await prisma.generationBatch.deleteMany({ where: { shop } });
    await prisma.processingBatch.deleteMany({ where: { shop } });
    await prisma.shopifyProduct.deleteMany({ where: { shop } });
    await prisma.imageSelection.deleteMany({ where: { shop } });
    await prisma.brandStylePreset.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
    await prisma.shopSyncState.deleteMany({ where: { shop } });
    await prisma.session.deleteMany({ where: { shop } });
  }
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("redactShopData", () => {
  it("deletes every row this app holds for the shop, across every domain", async () => {
    await seedEverything(SHOP, CONTEXT);

    const summary = await redactShopData(SHOP);

    expect(summary.shop).toBe(SHOP);

    // Every table is empty for this shop afterward.
    await Promise.all([
      expect(prisma.shopifyProduct.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.shopifyProductMedia.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.generationJob.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.generationResult.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.generationBatch.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.processingJob.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.processingResult.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.processingBatch.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.storeVisualJob.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.storeVisualResult.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.productIntelligence.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.imageSelection.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.imageSelectionItem.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.brandStylePreset.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.shopSettings.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.shopSyncState.count({ where: { shop: SHOP } })).resolves.toBe(0),
      expect(prisma.session.count({ where: { shop: SHOP } })).resolves.toBe(0),
    ]);
  });

  it("never touches another shop's data", async () => {
    await seedEverything(SHOP, CONTEXT);
    await seedEverything(OTHER_SHOP, OTHER_CONTEXT);

    await redactShopData(SHOP);

    expect(await prisma.shopifyProduct.count({ where: { shop: OTHER_SHOP } })).toBe(1);
    expect(await prisma.generationJob.count({ where: { shop: OTHER_SHOP } })).toBe(1);
    expect(await prisma.storeVisualJob.count({ where: { shop: OTHER_SHOP } })).toBe(1);
    expect(await prisma.brandStylePreset.count({ where: { shop: OTHER_SHOP } })).toBe(1);
    expect(await prisma.session.count({ where: { shop: OTHER_SHOP } })).toBe(1);
  });

  it("is idempotent — calling it again on an already-redacted shop is a safe no-op", async () => {
    await seedEverything(SHOP, CONTEXT);
    await redactShopData(SHOP);

    await expect(redactShopData(SHOP)).resolves.toMatchObject({ shop: SHOP });
    expect(await prisma.shopifyProduct.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("is a safe no-op for a shop that never had any data", async () => {
    await expect(redactShopData("never-installed-shop.myshopify.com")).resolves.toMatchObject({
      shop: "never-installed-shop.myshopify.com",
    });
  });
});
