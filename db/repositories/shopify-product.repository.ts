/**
 * Repository for the `ShopifyProduct` (+ its `ShopifyProductMedia`)
 * models — see db/repositories/README.md and prisma/schema.prisma.
 *
 * Every function that loads a resource by a client-supplied id takes the
 * caller's `AuthContext` and scopes the query to `context.shop` — never a
 * shop value from the browser (see CLAUDE.md "Security requirements").
 */
import type { Prisma, ProductStatus } from "@prisma/client";
import prisma from "../client.server";
import type { AuthContext } from "../../lib/auth/types";
import { assertShopOwnership } from "../../lib/auth/tenant.server";
import type { SyncedProduct } from "../../services/products/types";

export const PRODUCT_LIST_PAGE_SIZE = 20;

export interface ProductListFilters {
  search?: string;
  status?: ProductStatus;
}

/**
 * Pure query-builder — unit tested directly (tests/unit/products/search.test.ts)
 * without touching Prisma at runtime.
 *
 * Search decision (see docs/shopify-integration.md "Product search"): we
 * search our synchronized local table, not live Shopify, so the product
 * list can filter/paginate quickly regardless of catalog size and without
 * spending Shopify API rate-limit budget on every keystroke. Title/handle/
 * productType/vendor use a case-insensitive substring match; tags use exact
 * match (`has`) — a Postgres array doesn't support substring search without
 * an `unnest` + `ILIKE` raw query, which is more than Phase 1 needs. This is
 * a documented, deliberate limitation, not an oversight.
 */
export function buildProductListWhere(
  shop: string,
  filters: ProductListFilters,
): Prisma.ShopifyProductWhereInput {
  const where: Prisma.ShopifyProductWhereInput = { shop };

  if (filters.status) {
    where.status = filters.status;
  }

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { handle: { contains: search, mode: "insensitive" } },
      { productType: { contains: search, mode: "insensitive" } },
      { vendor: { contains: search, mode: "insensitive" } },
      { tags: { has: search } },
    ];
  }

  return where;
}

/** Clamps an arbitrary (possibly client-supplied) page number to a safe,
 * positive integer. Never trust a raw query-param value directly. */
export function clampPage(page: number | undefined | null): number {
  if (!page || !Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

export interface ProductListRow {
  id: string;
  shopifyProductId: string;
  title: string;
  handle: string;
  productType: string;
  status: ProductStatus;
  syncedAt: Date;
  media: Array<{ id: string; originalUrl: string; previewUrl: string | null; altText: string | null }>;
  _count: { media: number };
}

export interface ProductListPage {
  products: ProductListRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Lists products for the shop's Products page: paginated, optionally
 * filtered by search/status, ordered most-recently-synced-first. Includes
 * each product's media *ids* (small payload — see model comment) so the
 * client can offer "select all images" without a second round trip. */
export async function listProductsForShop(
  context: AuthContext,
  filters: ProductListFilters,
  page: number,
  pageSize: number = PRODUCT_LIST_PAGE_SIZE,
): Promise<ProductListPage> {
  const where = buildProductListWhere(context.shop, filters);
  const safePage = clampPage(page);

  const [products, total] = await prisma.$transaction([
    prisma.shopifyProduct.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (safePage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        shopifyProductId: true,
        title: true,
        handle: true,
        productType: true,
        status: true,
        syncedAt: true,
        media: {
          orderBy: { position: "asc" },
          select: { id: true, originalUrl: true, previewUrl: true, altText: true },
        },
        _count: { select: { media: true } },
      },
    }),
    prisma.shopifyProduct.count({ where }),
  ]);

  return { products, total, page: safePage, pageSize };
}

export interface ProductDetail {
  id: string;
  shop: string;
  shopifyProductId: string;
  title: string;
  handle: string;
  description: string;
  productType: string;
  category: string | null;
  vendor: string;
  tags: string[];
  status: ProductStatus;
  syncedAt: Date;
  // Shopify's own timestamp — used by services/intelligence/stale.ts as the
  // Product Intelligence staleness watermark (see that module's doc
  // comment for why Shopify's timestamp, not our local sync bookkeeping).
  shopifyUpdatedAt: Date;
  media: Array<{
    id: string;
    originalUrl: string;
    previewUrl: string | null;
    altText: string | null;
    width: number | null;
    height: number | null;
    position: number;
  }>;
}

/** Loads one product (with its media, ordered) by our internal id.
 * Verifies shop ownership before returning — see
 * lib/auth/tenant.server.ts. Returns `null` if not found for this shop. */
export async function findProductForShop(
  context: AuthContext,
  id: string,
): Promise<ProductDetail | null> {
  const product = await prisma.shopifyProduct.findUnique({
    where: { id },
    select: {
      id: true,
      shop: true,
      shopifyProductId: true,
      title: true,
      handle: true,
      description: true,
      productType: true,
      category: true,
      vendor: true,
      tags: true,
      status: true,
      syncedAt: true,
      shopifyUpdatedAt: true,
      media: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          originalUrl: true,
          previewUrl: true,
          altText: true,
          width: true,
          height: true,
          position: true,
        },
      },
    },
  });

  if (!product) return null;
  assertShopOwnership(context, product.shop);
  return product;
}

/**
 * Safe-upsert for one synced product + its media, keyed by
 * `[shop, shopifyProductId]` (product) and `[shop, shopifyMediaId]` (each
 * media item) — see prisma/schema.prisma's `@@unique` constraints. Media no
 * longer present on the Shopify side is removed; media still present is
 * upserted (updates in place rather than duplicating on re-sync).
 *
 * Runs in a transaction so a product's row and its media set never end up
 * partially updated if one write fails mid-sync.
 */
export async function upsertSyncedProduct(shop: string, product: SyncedProduct): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.shopifyProduct.upsert({
      where: { shop_shopifyProductId: { shop, shopifyProductId: product.shopifyProductId } },
      create: {
        shop,
        shopifyProductId: product.shopifyProductId,
        title: product.title,
        handle: product.handle,
        description: product.description,
        productType: product.productType,
        category: product.category,
        vendor: product.vendor,
        tags: product.tags,
        status: product.status,
        shopifyCreatedAt: product.shopifyCreatedAt,
        shopifyUpdatedAt: product.shopifyUpdatedAt,
        syncedAt: new Date(),
      },
      update: {
        title: product.title,
        handle: product.handle,
        description: product.description,
        productType: product.productType,
        category: product.category,
        vendor: product.vendor,
        tags: product.tags,
        status: product.status,
        shopifyUpdatedAt: product.shopifyUpdatedAt,
        syncedAt: new Date(),
      },
      select: { id: true },
    });

    const currentMediaIds = product.media.map((media) => media.shopifyMediaId);

    await tx.shopifyProductMedia.deleteMany({
      where: {
        shop,
        productId: row.id,
        ...(currentMediaIds.length > 0 ? { shopifyMediaId: { notIn: currentMediaIds } } : {}),
      },
    });

    for (const media of product.media) {
      await tx.shopifyProductMedia.upsert({
        where: { shop_shopifyMediaId: { shop, shopifyMediaId: media.shopifyMediaId } },
        create: {
          shop,
          productId: row.id,
          shopifyProductId: product.shopifyProductId,
          shopifyMediaId: media.shopifyMediaId,
          mediaType: media.mediaType,
          originalUrl: media.originalUrl,
          previewUrl: media.previewUrl,
          width: media.width,
          height: media.height,
          altText: media.altText,
          position: media.position,
          syncedAt: new Date(),
        },
        update: {
          originalUrl: media.originalUrl,
          previewUrl: media.previewUrl,
          width: media.width,
          height: media.height,
          altText: media.altText,
          position: media.position,
          syncedAt: new Date(),
        },
      });
    }
  });
}

/** Deletes a locally synced product (and, by cascade, its media and any
 * selection items referencing it) in response to a Shopify product
 * deletion. Idempotent: a no-op if the product was already removed. */
export async function deleteSyncedProduct(shop: string, shopifyProductId: string): Promise<void> {
  await prisma.shopifyProduct.deleteMany({ where: { shop, shopifyProductId } });
}
