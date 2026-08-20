/**
 * Shared types for the product catalog sync + source-image-selection
 * domain. Pure types only — no I/O, no Prisma, no Shopify SDK — so any
 * module (services, repositories, routes, tests) can depend on this
 * without pulling in a runtime dependency.
 */

export type SyncedProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT";

/** One product image, mapped from Shopify's GraphQL `MediaImage` into the
 * shape `ShopifyProductMedia` upserts store. Only `mediaContentType: IMAGE`
 * media is represented here — see prisma/schema.prisma's model comment. */
export interface SyncedProductMedia {
  shopifyMediaId: string;
  mediaType: string;
  originalUrl: string;
  previewUrl: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  position: number;
}

/** One product, mapped from Shopify's GraphQL `Product` into the shape
 * `ShopifyProduct` upserts store. */
export interface SyncedProduct {
  shopifyProductId: string;
  title: string;
  handle: string;
  description: string;
  productType: string;
  category: string | null;
  vendor: string;
  tags: string[];
  status: SyncedProductStatus;
  shopifyCreatedAt: Date;
  shopifyUpdatedAt: Date;
  media: SyncedProductMedia[];
}

/** How a catalog sync run should scope its query to Shopify. */
export type SyncMode = "full" | "incremental";

export interface SyncResult {
  mode: SyncMode;
  productsSynced: number;
  pagesFetched: number;
}

/** Server-side representation of one merchant-chosen source image, before
 * it has been persisted as an `ImageSelectionItem` — see
 * services/products/selection.server.ts. */
export interface SelectionInput {
  /** Our internal `ShopifyProduct.id`. */
  productId: string;
  /** Our internal `ShopifyProductMedia.id`. */
  productMediaId: string;
}

export interface SelectionSummaryProduct {
  productId: string;
  title: string;
  handle: string;
  thumbnailUrl: string | null;
  images: Array<{ productMediaId: string; url: string; altText: string | null }>;
}

export interface SelectionSummary {
  selectionId: string;
  productCount: number;
  imageCount: number;
  products: SelectionSummaryProduct[];
}
