/**
 * Pure mapping: Shopify Admin GraphQL `Product`/media nodes -> the shape
 * our database upserts (`SyncedProduct`/`SyncedProductMedia`). No I/O, no
 * Prisma, no Shopify SDK — unit tested directly against fixture GraphQL
 * response shapes (see tests/unit/products/mapping.test.ts).
 *
 * Only `mediaContentType: "IMAGE"` media nodes become `SyncedProductMedia`
 * — video/3D/external-video media aren't meaningful "source images" for
 * the future AI pipeline (see prisma/schema.prisma's model comment), so
 * they're mapped out here rather than persisted and ignored downstream.
 */
import type { SyncedProduct, SyncedProductMedia, SyncedProductStatus } from "./types";

export interface RawShopifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

export interface RawShopifyMediaNode {
  id: string;
  alt: string | null;
  mediaContentType: string;
  /** Present only on `MediaImage` nodes (inline fragment in the query). */
  image?: RawShopifyImage | null;
  /** Aliased, transformed thumbnail — see services/products/shopify-queries.server.ts. */
  thumbnail?: { url: string } | null;
}

export interface RawShopifyProductCategory {
  id: string;
  fullName: string;
}

export interface RawShopifyProductNode {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[] | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  category?: RawShopifyProductCategory | null;
  media: { nodes: RawShopifyMediaNode[] };
}

const KNOWN_STATUSES: readonly SyncedProductStatus[] = ["ACTIVE", "ARCHIVED", "DRAFT"];

export class UnknownProductStatusError extends Error {
  constructor(status: string) {
    super(`Unknown Shopify product status: "${status}"`);
    this.name = "UnknownProductStatusError";
  }
}

function mapStatus(status: string): SyncedProductStatus {
  const match = KNOWN_STATUSES.find((known) => known === status);
  if (!match) {
    throw new UnknownProductStatusError(status);
  }
  return match;
}

function mapMediaNode(node: RawShopifyMediaNode, position: number): SyncedProductMedia | null {
  if (node.mediaContentType !== "IMAGE" || !node.image) {
    return null;
  }

  return {
    shopifyMediaId: node.id,
    mediaType: node.mediaContentType,
    originalUrl: node.image.url,
    previewUrl: node.thumbnail?.url ?? null,
    width: node.image.width,
    height: node.image.height,
    altText: node.alt,
    position,
  };
}

/** Maps one Shopify GraphQL product node (as returned by the sync queries
 * in services/products/shopify-queries.server.ts) into the shape
 * `db/repositories/shopify-product.repository.ts`'s upsert expects.
 * Media position is assigned by array order, after filtering out non-image
 * media, so positions stay contiguous (0, 1, 2, ...) in our own table. */
export function mapProductNode(node: RawShopifyProductNode): SyncedProduct {
  const media = node.media.nodes
    .map((mediaNode, index) => mapMediaNode(mediaNode, index))
    .filter((mediaNode): mediaNode is SyncedProductMedia => mediaNode !== null)
    // Re-index positions contiguously in case some nodes were filtered out.
    .map((mediaNode, index) => ({ ...mediaNode, position: index }));

  return {
    shopifyProductId: node.id,
    title: node.title,
    handle: node.handle,
    description: node.description ?? "",
    productType: node.productType ?? "",
    category: node.category?.fullName ?? null,
    vendor: node.vendor ?? "",
    tags: node.tags ?? [],
    status: mapStatus(node.status),
    shopifyCreatedAt: new Date(node.createdAt),
    shopifyUpdatedAt: new Date(node.updatedAt),
    media,
  };
}
