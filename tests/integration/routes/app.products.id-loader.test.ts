/**
 * Integration test for app/routes/app.products.$id.tsx's loader — verifies
 * it converts a `TenantMismatchError` into the same safe "not found"
 * response as a genuinely missing id (Fix 3, see the Phase 0/1 security
 * audit's "existence oracle" finding), and that the specific detail is
 * still logged server-side.
 *
 * Authenticates via the E2E test seam (services/shopify/admin-context.
 * server.ts) rather than real Shopify OAuth — see tests/e2e/products.spec.ts
 * for the same pattern used end-to-end through a real browser; this test
 * calls the loader function directly against a real local Postgres.
 *
 * `ALLOW_E2E_AUTH_BYPASS` is set (and the cached `getEnv()` result reset)
 * in `beforeAll`, not at module load — `services/shopify/client.server.ts`
 * calls `getEnv()` at *its own* module top level, and ES module imports
 * are hoisted ahead of this file's own statements, so setting the env var
 * here before the `import`s would be too late to matter; `getEnv()` would
 * already have cached a value without it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { logger } from "../../../lib/logging/logger.server";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { loader } from "../../../app/routes/app.products.$id";
import { createGenerationJob, createResults as createGenerationResults } from "../../../db/repositories/generation-job.repository";
import { parseGenerationPlan } from "../../../services/generation/schema";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "loader-test-a.myshopify.com";
const SHOP_B = "loader-test-b.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: `Product ${id}`,
    handle: `product-${id}`,
    description: "",
    productType: "",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [],
  };
}

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/products/x", {
    headers: { "x-ai-imageshoot-e2e-shop": shop },
  });
}

async function callLoader(shop: string, id: string) {
  return loader({
    request: requestFor(shop),
    params: { id },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  resetEnvCacheForTests();
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("app.products.$id loader — tenant mismatch / not-found handling", () => {
  it("returns the product when it belongs to the requesting shop", async () => {
    await upsertSyncedProduct(SHOP_A, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_A } });

    const result = await callLoader(SHOP_A, row.id);

    expect(result.product.title).toBe("Product gid://shopify/Product/1");
  });

  it("throws a safe 404 Response for an id that doesn't exist at all", async () => {
    await expect(callLoader(SHOP_A, "does-not-exist")).rejects.toMatchObject({ status: 404 });
  });

  it("throws the SAME safe 404 Response — not a leaked TenantMismatchError — for a real id belonging to another shop", async () => {
    await upsertSyncedProduct(SHOP_B, product("gid://shopify/Product/1"));
    const otherShopRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_B } });

    let caught: unknown;
    try {
      await callLoader(SHOP_A, otherShopRow.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    const response = caught as Response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Product not found");
    // Never a TenantMismatchError (or its message) escaping the loader.
    expect((caught as Error)?.name).not.toBe("TenantMismatchError");
  });

  it("still logs the tenant-mismatch attempt server-side, with the real shop/id detail", async () => {
    await upsertSyncedProduct(SHOP_B, product("gid://shopify/Product/2"));
    const otherShopRow = await prisma.shopifyProduct.findFirstOrThrow({
      where: { shop: SHOP_B, shopifyProductId: "gid://shopify/Product/2" },
    });

    const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await expect(callLoader(SHOP_A, otherShopRow.id)).rejects.toMatchObject({ status: 404 });

      expect(spy).toHaveBeenCalledWith(
        "products.detail.tenant_mismatch",
        expect.objectContaining({ shop: SHOP_A, requestedId: otherShopRow.id }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe("app.products.$id loader — no internal storage path leakage", () => {
  it("never includes a generation result's storageKey in the loader's returned data", async () => {
    await upsertSyncedProduct(SHOP_A, product("gid://shopify/Product/3"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({
      where: { shop: SHOP_A, shopifyProductId: "gid://shopify/Product/3" },
    });

    const job = await createGenerationJob({
      shop: SHOP_A,
      productId: row.id,
      type: "LIFESTYLE",
      sourceMediaIds: [],
      plan: parseGenerationPlan({
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
      }),
    });
    const storageKey = `shops/${SHOP_A}/generation/${job.id}/0.png`;
    await createGenerationResults(SHOP_A, job.id, [
      {
        storageKey,
        url: null,
        width: 1024,
        height: 1024,
        format: "png",
        providerName: "deterministic-test",
        providerResultId: null,
        metadata: null,
      },
    ]);

    const result = await callLoader(SHOP_A, row.id);

    expect(result.generationHistory).toHaveLength(1);
    // The raw key is not present as its own field...
    expect(result.generationHistory[0].results[0]).not.toHaveProperty("storageKey");
    // ...though it legitimately still appears embedded inside the
    // fetchable, HMAC-signed `/media/...?expires=...&sig=...` url — that
    // is the intended mechanism (see app/routes/media.$.tsx), not a leak:
    // the key alone, without a valid signature/expiry, grants nothing.
    const url = result.generationHistory[0].results[0].url!;
    expect(url).toContain(storageKey);
    expect(url).toMatch(/[?&]sig=/);
  });
});
