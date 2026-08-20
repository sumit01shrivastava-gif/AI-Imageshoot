/**
 * Integration test for app/routes/app.products.selection.tsx's
 * "start-processing" action — verifies it creates a `ProcessingBatch`
 * from a saved `ImageSelection` and redirects into
 * app/routes/app.processing.$batchId.tsx. The batch/job/provider/storage
 * layers themselves are covered by
 * tests/integration/processing/batch-processing.test.ts; this file is
 * about the route wiring only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP = "route-selection-start-test.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Studio Sofa",
    handle: "studio-sofa",
    description: "",
    productType: "Furniture",
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
        originalUrl: "https://cdn.shopify.com/sofa.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio sofa",
        position: 0,
      },
    ],
  };
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
  await prisma.processingBatch.deleteMany({ where: { shop: SHOP } });
}

let action: typeof import("../../../app/routes/app.products.selection").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.IMAGE_PROCESSING_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ action } = await import("../../../app/routes/app.products.selection"));
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  delete process.env.IMAGE_PROCESSING_PROVIDER;
  resetEnvCacheForTests();
});

async function callAction(request: Request) {
  return action({ request, params: {}, context: {} } as unknown as Parameters<typeof action>[0]);
}

describe("app.products.selection — 'start-processing' action", () => {
  it("creates a batch from a saved selection and redirects into the batch progress page", async () => {
    await upsertSyncedProduct(SHOP, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({
      where: { shop: SHOP },
      include: { media: true },
    });

    const confirmResult = await callAction(
      requestFor(SHOP, { entries: JSON.stringify([{ productId: row.id, productMediaId: row.media[0].id }]) }),
    );
    expect(confirmResult).toMatchObject({ ok: true });
    const selectionId = (confirmResult as { ok: true; selectionId: string }).selectionId;

    const startResult = await callAction(
      requestFor(SHOP, { intent: "start-processing", selectionId, operation: "REMOVE_BACKGROUND" }),
    );

    expect(startResult).toBeInstanceOf(Response);
    expect((startResult as Response).status).toBe(302);
    const location = (startResult as Response).headers.get("Location");
    expect(location).toMatch(/^\/app\/processing\//);

    const batchId = location!.replace("/app/processing/", "");
    const batch = await prisma.processingBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.shop).toBe(SHOP);
    expect(batch.operation).toBe("REMOVE_BACKGROUND");
  });

  it("returns a safe error for a selection id that doesn't exist", async () => {
    const result = await callAction(
      requestFor(SHOP, { intent: "start-processing", selectionId: "does-not-exist", operation: "REMOVE_BACKGROUND" }),
    );
    expect(result).toEqual({ ok: false, error: "Selection not found" });
  });
});
