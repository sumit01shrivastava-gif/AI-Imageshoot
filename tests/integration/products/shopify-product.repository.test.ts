/**
 * Integration tests: db/repositories/shopify-product.repository.ts against
 * a real local Postgres (docker-compose — see tests/setup.ts). No Shopify
 * API/network calls here; `upsertSyncedProduct`'s input is a plain
 * `SyncedProduct` object, same as what services/products/mapping.ts would
 * produce.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import {
  upsertSyncedProduct,
  deleteSyncedProduct,
  findProductForShop,
  listProductsForShop,
} from "../../../db/repositories/shopify-product.repository";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "shop-a.integration-test.myshopify.com";
const SHOP_B = "shop-b.integration-test.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };
const CONTEXT_B: AuthContext = { shop: SHOP_B, sessionId: "s2", isOnline: false };

function product(overrides: Partial<SyncedProduct> = {}): SyncedProduct {
  return {
    shopifyProductId: "gid://shopify/Product/1",
    title: "Premium Leather Bag",
    handle: "premium-leather-bag",
    description: "A handcrafted leather bag.",
    productType: "Bags",
    category: null,
    vendor: "Acme",
    tags: ["leather"],
    status: "ACTIVE",
    shopifyCreatedAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    media: [
      {
        shopifyMediaId: "gid://shopify/MediaImage/1",
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/1.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Front",
        position: 0,
      },
    ],
    ...overrides,
  };
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

describe("upsertSyncedProduct", () => {
  it("creates a product with its media on first sync", async () => {
    await upsertSyncedProduct(SHOP_A, product());

    const row = await prisma.shopifyProduct.findUniqueOrThrow({
      where: { shop_shopifyProductId: { shop: SHOP_A, shopifyProductId: "gid://shopify/Product/1" } },
      include: { media: true },
    });

    expect(row.title).toBe("Premium Leather Bag");
    expect(row.media).toHaveLength(1);
    expect(row.media[0].originalUrl).toBe("https://cdn.shopify.com/1.jpg");
  });

  it("updates in place on re-sync instead of duplicating (safe upsert)", async () => {
    await upsertSyncedProduct(SHOP_A, product());
    await upsertSyncedProduct(SHOP_A, product({ title: "Premium Leather Bag (Updated)" }));

    const rows = await prisma.shopifyProduct.findMany({
      where: { shop: SHOP_A, shopifyProductId: "gid://shopify/Product/1" },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Premium Leather Bag (Updated)");
  });

  it("removes media no longer present and adds new media on re-sync", async () => {
    await upsertSyncedProduct(SHOP_A, product());
    await upsertSyncedProduct(
      SHOP_A,
      product({
        media: [
          {
            shopifyMediaId: "gid://shopify/MediaImage/2",
            mediaType: "IMAGE",
            originalUrl: "https://cdn.shopify.com/2.jpg",
            previewUrl: null,
            width: 800,
            height: 600,
            altText: "New image",
            position: 0,
          },
        ],
      }),
    );

    const media = await prisma.shopifyProductMedia.findMany({
      where: { shop: SHOP_A, shopifyProductId: "gid://shopify/Product/1" },
    });

    expect(media).toHaveLength(1);
    expect(media[0].shopifyMediaId).toBe("gid://shopify/MediaImage/2");
  });

  it("keeps products for different shops isolated even with the same shopifyProductId", async () => {
    await upsertSyncedProduct(SHOP_A, product());
    await upsertSyncedProduct(SHOP_B, product({ title: "Same Shopify ID, Different Shop" }));

    const a = await findProductForShop(CONTEXT_A, (await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_A } })).id);
    const b = await findProductForShop(CONTEXT_B, (await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_B } })).id);

    expect(a?.title).toBe("Premium Leather Bag");
    expect(b?.title).toBe("Same Shopify ID, Different Shop");
  });
});

describe("deleteSyncedProduct", () => {
  it("removes the product and cascades to its media", async () => {
    await upsertSyncedProduct(SHOP_A, product());
    await deleteSyncedProduct(SHOP_A, "gid://shopify/Product/1");

    const rows = await prisma.shopifyProduct.findMany({ where: { shop: SHOP_A } });
    const media = await prisma.shopifyProductMedia.findMany({ where: { shop: SHOP_A } });
    expect(rows).toHaveLength(0);
    expect(media).toHaveLength(0);
  });

  it("is idempotent — deleting an already-deleted product is a no-op", async () => {
    await expect(deleteSyncedProduct(SHOP_A, "gid://shopify/Product/does-not-exist")).resolves.toBeUndefined();
  });
});

describe("findProductForShop", () => {
  it("returns null for a product that doesn't exist", async () => {
    const result = await findProductForShop(CONTEXT_A, "does-not-exist");
    expect(result).toBeNull();
  });

  it("throws TenantMismatchError instead of returning another shop's product", async () => {
    await upsertSyncedProduct(SHOP_B, product());
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_B } });

    await expect(findProductForShop(CONTEXT_A, row.id)).rejects.toThrow(TenantMismatchError);
  });
});

describe("listProductsForShop", () => {
  it("only returns products for the given shop", async () => {
    await upsertSyncedProduct(SHOP_A, product());
    await upsertSyncedProduct(SHOP_B, product({ shopifyProductId: "gid://shopify/Product/2" }));

    const { products, total } = await listProductsForShop(CONTEXT_A, {}, 1);
    expect(total).toBe(1);
    expect(products).toHaveLength(1);
    expect(products[0].shopifyProductId).toBe("gid://shopify/Product/1");
  });

  it("filters by search across title/handle/productType/vendor", async () => {
    await upsertSyncedProduct(SHOP_A, product());
    await upsertSyncedProduct(
      SHOP_A,
      product({ shopifyProductId: "gid://shopify/Product/2", title: "Canvas Tote", handle: "canvas-tote" }),
    );

    const { products } = await listProductsForShop(CONTEXT_A, { search: "canvas" }, 1);
    expect(products).toHaveLength(1);
    expect(products[0].title).toBe("Canvas Tote");
  });

  it("paginates with a stable page size", async () => {
    for (let i = 0; i < 3; i++) {
      await upsertSyncedProduct(SHOP_A, product({ shopifyProductId: `gid://shopify/Product/${i}` }));
    }

    const page1 = await listProductsForShop(CONTEXT_A, {}, 1, 2);
    const page2 = await listProductsForShop(CONTEXT_A, {}, 2, 2);

    expect(page1.products).toHaveLength(2);
    expect(page2.products).toHaveLength(1);
    expect(page1.total).toBe(3);
  });
});
