/**
 * Integration test for app/routes/app.products.selection.tsx's
 * "start-lifestyle-batch" action — verifies it creates a `GenerationBatch`
 * from a saved `ImageSelection` and redirects into
 * app/routes/app.generation.$batchId.tsx. The batch/job/provider/storage
 * layers themselves are covered by
 * tests/integration/generation/batch-generation.test.ts; this file is
 * about the route wiring only. Mirrors
 * app.products.selection-start-processing.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP = "route-selection-lifestyle-start-test.myshopify.com";

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
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId }, include: { media: true } });
  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["lifestyle"],
    identityAnchors: { category: "Handbags", material: "Leather" },
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });
  return row;
}

function requestFor(shop: string, body: Record<string, string>): Request {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  return new Request("https://example.com/app/products/selection", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.generationBatch.deleteMany({ where: { shop: SHOP } });
}

let action: typeof import("../../../app/routes/app.products.selection").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ action } = await import("../../../app/routes/app.products.selection"));
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
  resetEnvCacheForTests();
});

async function callAction(request: Request) {
  return action({ request, params: {}, context: {} } as unknown as Parameters<typeof action>[0]);
}

describe("app.products.selection — 'start-lifestyle-batch' action", () => {
  it("creates a GenerationBatch from a saved selection and redirects into the batch progress page", async () => {
    const row = await seedAnalyzed(SHOP, "gid://shopify/Product/1");

    const confirmResult = await callAction(
      requestFor(SHOP, { entries: JSON.stringify([{ productId: row.id, productMediaId: row.media[0].id }]) }),
    );
    expect(confirmResult).toMatchObject({ ok: true });
    const selectionId = (confirmResult as { ok: true; selectionId: string }).selectionId;

    const startResult = await callAction(
      requestFor(SHOP, { intent: "start-lifestyle-batch", selectionId, presetId: "warm-lifestyle" }),
    );

    expect(startResult).toBeInstanceOf(Response);
    expect((startResult as Response).status).toBe(302);
    const location = (startResult as Response).headers.get("Location");
    expect(location).toMatch(/^\/app\/generation\//);

    const batchId = location!.replace("/app/generation/", "");
    const batch = await prisma.generationBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.shop).toBe(SHOP);
    expect(batch.generationType).toBe("LIFESTYLE");
  });

  it("returns a safe error for a selection id that doesn't exist", async () => {
    const result = await callAction(
      requestFor(SHOP, { intent: "start-lifestyle-batch", selectionId: "does-not-exist" }),
    );
    expect(result).toEqual({ ok: false, error: "Selection not found" });
  });
});
