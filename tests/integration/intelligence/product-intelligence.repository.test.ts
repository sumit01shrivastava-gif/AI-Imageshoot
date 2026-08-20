/**
 * Integration tests: db/repositories/product-intelligence.repository.ts
 * against a real local Postgres (docker-compose — see tests/setup.ts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import {
  getForProduct,
  ensurePendingAnalysis,
  markProcessing,
  markFailed,
  saveResult,
} from "../../../db/repositories/product-intelligence.repository";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";

const SHOP_A = "intel-test-a.myshopify.com";
const SHOP_B = "intel-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };

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
    media: [],
  };
}

function validAnalysis() {
  return parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: true,
    recommendedAssetTypes: ["product_studio", "lifestyle"],
    identityAnchors: { category: "Handbags", primaryColor: "Red", material: "Leather" },
    primaryColor: "Red",
    material: "Leather",
    confidence: 0.9,
  });
}

async function seedProduct(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  return prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("ensurePendingAnalysis", () => {
  it("creates a PENDING row when none exists", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    await ensurePendingAnalysis(SHOP_A, row.id);

    const intelligence = await getForProduct(CONTEXT_A, row.id);
    expect(intelligence?.status).toBe("PENDING");
  });

  it("is idempotent and non-destructive — doesn't reset an already-READY profile", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    await saveResult(SHOP_A, row.id, validAnalysis(), {
      providerName: "test",
      sourceShopifyUpdatedAt: new Date(),
      rawAnalysis: { ok: true },
    });

    await ensurePendingAnalysis(SHOP_A, row.id);

    const intelligence = await getForProduct(CONTEXT_A, row.id);
    expect(intelligence?.status).toBe("READY");
    expect(intelligence?.category).toBe("Handbags");
  });
});

describe("analysis lifecycle", () => {
  it("PENDING -> PROCESSING -> READY", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    await ensurePendingAnalysis(SHOP_A, row.id);
    expect((await getForProduct(CONTEXT_A, row.id))?.status).toBe("PENDING");

    await markProcessing(SHOP_A, row.id);
    expect((await getForProduct(CONTEXT_A, row.id))?.status).toBe("PROCESSING");

    await saveResult(SHOP_A, row.id, validAnalysis(), {
      providerName: "deterministic-test",
      sourceShopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      rawAnalysis: { raw: true },
    });

    const ready = await getForProduct(CONTEXT_A, row.id);
    expect(ready?.status).toBe("READY");
    expect(ready?.category).toBe("Handbags");
    expect(ready?.primaryColor).toBe("Red");
    expect(ready?.modelSuitable).toBe(true);
    expect(ready?.analysisVersion).toBe(1);
    expect(ready?.providerName).toBe("deterministic-test");
    // rawAnalysis is never returned by the safe-select read path.
    expect((ready as unknown as { rawAnalysis?: unknown }).rawAnalysis).toBeUndefined();
  });

  it("PROCESSING -> FAILED, with a merchant-safe message", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    await markProcessing(SHOP_A, row.id);
    await markFailed(SHOP_A, row.id, "Analysis failed. Please try analyzing again in a moment.");

    const failed = await getForProduct(CONTEXT_A, row.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.errorMessage).toBe("Analysis failed. Please try analyzing again in a moment.");
  });

  it("re-analysis bumps analysisVersion and overwrites the previous profile in place", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    await saveResult(SHOP_A, row.id, validAnalysis(), {
      providerName: "test",
      sourceShopifyUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      rawAnalysis: {},
    });
    const first = await getForProduct(CONTEXT_A, row.id);
    expect(first?.analysisVersion).toBe(1);

    const secondAnalysis = parseProductIntelligenceOutput({
      category: "Handbags",
      modelSuitable: true,
      recommendedAssetTypes: ["detail"],
      identityAnchors: { category: "Handbags" },
      primaryColor: "Blue", // e.g. a corrected re-analysis
    });
    await saveResult(SHOP_A, row.id, secondAnalysis, {
      providerName: "test",
      sourceShopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      rawAnalysis: {},
    });

    const rows = await prisma.productIntelligence.findMany({ where: { productId: row.id } });
    expect(rows).toHaveLength(1); // still one row per product, not a new one
    const second = await getForProduct(CONTEXT_A, row.id);
    expect(second?.analysisVersion).toBe(2);
    expect(second?.primaryColor).toBe("Blue");
    expect(second?.recommendedAssetTypes).toEqual(["detail"]);
  });
});

describe("tenant isolation", () => {
  it("getForProduct throws TenantMismatchError rather than returning another shop's profile", async () => {
    const rowB = await seedProduct(SHOP_B, "gid://shopify/Product/1");
    await saveResult(SHOP_B, rowB.id, validAnalysis(), {
      providerName: "test",
      sourceShopifyUpdatedAt: new Date(),
      rawAnalysis: {},
    });

    await expect(getForProduct(CONTEXT_A, rowB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a product id that doesn't exist", async () => {
    expect(await getForProduct(CONTEXT_A, "does-not-exist")).toBeNull();
  });

  it("deleting the underlying product cascades to its intelligence profile", async () => {
    const row = await seedProduct(SHOP_A, "gid://shopify/Product/1");
    await saveResult(SHOP_A, row.id, validAnalysis(), {
      providerName: "test",
      sourceShopifyUpdatedAt: new Date(),
      rawAnalysis: {},
    });

    await prisma.shopifyProduct.delete({ where: { id: row.id } });

    const remaining = await prisma.productIntelligence.findMany({ where: { productId: row.id } });
    expect(remaining).toHaveLength(0);
  });
});
