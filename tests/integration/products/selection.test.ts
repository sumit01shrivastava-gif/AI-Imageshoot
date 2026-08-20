/**
 * Integration tests: services/products/selection.server.ts +
 * db/repositories/image-selection.repository.ts against a real local
 * Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import {
  createImageSelection,
  getImageSelectionSummary,
  InvalidSelectionError,
  MAX_SELECTION_ITEMS,
} from "../../../services/products/selection.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { SyncedProduct } from "../../../services/products/types";

const SHOP_A = "selection-test-a.myshopify.com";
const SHOP_B = "selection-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };

function product(id: string, mediaIds: string[]): SyncedProduct {
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
    media: mediaIds.map((mediaId, index) => ({
      shopifyMediaId: mediaId,
      mediaType: "IMAGE",
      originalUrl: `https://cdn.shopify.com/${mediaId}.jpg`,
      previewUrl: null,
      width: null,
      height: null,
      altText: null,
      position: index,
    })),
  };
}

async function cleanup() {
  await prisma.imageSelection.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function seedProductWithMedia(shop: string, shopifyProductId: string, mediaIds: string[]) {
  await upsertSyncedProduct(shop, product(shopifyProductId, mediaIds));
  return prisma.shopifyProduct.findFirstOrThrow({
    where: { shop, shopifyProductId },
    include: { media: true },
  });
}

describe("createImageSelection", () => {
  it("persists a selection referencing real product/media rows", async () => {
    const bag = await seedProductWithMedia(SHOP_A, "gid://shopify/Product/1", ["m1", "m2"]);

    const selectionId = await createImageSelection(CONTEXT_A, [
      { productId: bag.id, productMediaId: bag.media[0].id },
      { productId: bag.id, productMediaId: bag.media[1].id },
    ]);

    const items = await prisma.imageSelectionItem.findMany({ where: { selectionId } });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.shop === SHOP_A)).toBe(true);
  });

  it("de-duplicates repeated (productId, productMediaId) pairs", async () => {
    const bag = await seedProductWithMedia(SHOP_A, "gid://shopify/Product/1", ["m1"]);

    const selectionId = await createImageSelection(CONTEXT_A, [
      { productId: bag.id, productMediaId: bag.media[0].id },
      { productId: bag.id, productMediaId: bag.media[0].id },
    ]);

    const items = await prisma.imageSelectionItem.findMany({ where: { selectionId } });
    expect(items).toHaveLength(1);
  });

  it("rejects an empty selection", async () => {
    await expect(createImageSelection(CONTEXT_A, [])).rejects.toThrow(InvalidSelectionError);
  });

  it("rejects more than MAX_SELECTION_ITEMS", async () => {
    const bag = await seedProductWithMedia(SHOP_A, "gid://shopify/Product/1", ["m1"]);
    const tooMany = Array.from({ length: MAX_SELECTION_ITEMS + 1 }, (_, i) => ({
      productId: bag.id,
      productMediaId: `${bag.media[0].id}-${i}`,
    }));

    await expect(createImageSelection(CONTEXT_A, tooMany)).rejects.toThrow(InvalidSelectionError);
  });

  it("rejects a productMediaId that doesn't belong to the caller's shop (never trusts client-supplied ids)", async () => {
    const otherShopProduct = await seedProductWithMedia(SHOP_B, "gid://shopify/Product/1", ["m1"]);

    await expect(
      createImageSelection(CONTEXT_A, [
        { productId: otherShopProduct.id, productMediaId: otherShopProduct.media[0].id },
      ]),
    ).rejects.toThrow(InvalidSelectionError);
  });

  it("rejects a productId/productMediaId pair that don't actually belong together", async () => {
    const bag = await seedProductWithMedia(SHOP_A, "gid://shopify/Product/1", ["m1"]);
    const tote = await seedProductWithMedia(SHOP_A, "gid://shopify/Product/2", ["m2"]);

    await expect(
      createImageSelection(CONTEXT_A, [{ productId: bag.id, productMediaId: tote.media[0].id }]),
    ).rejects.toThrow(InvalidSelectionError);
  });
});

describe("getImageSelectionSummary", () => {
  it("groups selected images by product with correct counts", async () => {
    const bag = await seedProductWithMedia(SHOP_A, "gid://shopify/Product/1", ["m1", "m2"]);
    const tote = await seedProductWithMedia(SHOP_A, "gid://shopify/Product/2", ["m3"]);

    const selectionId = await createImageSelection(CONTEXT_A, [
      { productId: bag.id, productMediaId: bag.media[0].id },
      { productId: bag.id, productMediaId: bag.media[1].id },
      { productId: tote.id, productMediaId: tote.media[0].id },
    ]);

    const summary = await getImageSelectionSummary(CONTEXT_A, selectionId);

    expect(summary?.productCount).toBe(2);
    expect(summary?.imageCount).toBe(3);
    expect(summary?.products.map((p) => p.title).sort()).toEqual([
      "Product gid://shopify/Product/1",
      "Product gid://shopify/Product/2",
    ]);
  });

  it("returns null for a selection id that doesn't exist", async () => {
    const summary = await getImageSelectionSummary(CONTEXT_A, "does-not-exist");
    expect(summary).toBeNull();
  });

  it("throws rather than returning another shop's selection", async () => {
    const bag = await seedProductWithMedia(SHOP_B, "gid://shopify/Product/1", ["m1"]);
    const otherContext: AuthContext = { shop: SHOP_B, sessionId: "s2", isOnline: false };
    const selectionId = await createImageSelection(otherContext, [
      { productId: bag.id, productMediaId: bag.media[0].id },
    ]);

    await expect(getImageSelectionSummary(CONTEXT_A, selectionId)).rejects.toThrow();
  });
});
