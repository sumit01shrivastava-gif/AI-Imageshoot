/**
 * Product-catalog-specific Admin GraphQL queries.
 *
 * `services/shopify/` owns the Shopify SDK, auth, and the generic
 * request/error-handling transport (`executeAdminGraphQL`). This module
 * owns the query *documents* for this domain (products/media), the same
 * way `db/repositories/*` owns domain-specific Prisma queries while
 * `db/client.server.ts` just owns the client. Nothing outside
 * `services/shopify/` imports the Shopify SDK directly — this file only
 * imports the transport helper.
 *
 * API version: matches `services/shopify/client.server.ts`
 * (`ApiVersion.October25`) / `shopify.app.toml`'s `[webhooks].api_version`.
 * Bump both together.
 */
import { executeAdminGraphQL, type AdminGraphQLClient } from "../shopify/graphql.server";
import type { RawShopifyProductNode } from "./mapping";

/** Bounds per-page GraphQL cost — see docs/shopify-integration.md
 * "Pagination and cost". */
export const PRODUCTS_PAGE_SIZE = 25;
/** Only the first N images per product are synced in Phase 1 — see
 * docs/database.md "Known limitations". */
const MEDIA_PER_PRODUCT = 20;

const PRODUCT_FIELDS = `#graphql
  id
  title
  handle
  description
  productType
  vendor
  tags
  status
  createdAt
  updatedAt
  category {
    id
    fullName
  }
  media(first: ${MEDIA_PER_PRODUCT}) {
    nodes {
      id
      alt
      mediaContentType
      ... on MediaImage {
        image {
          url
          width
          height
        }
        thumbnail: image {
          url(transform: { maxWidth: 400, maxHeight: 400, crop: CENTER })
        }
      }
    }
  }
`;

const PRODUCTS_PAGE_QUERY = `#graphql
  query CatalogSyncProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ${PRODUCT_FIELDS}
      }
    }
  }
`;

const SINGLE_PRODUCT_QUERY = `#graphql
  query CatalogSyncSingleProduct($id: ID!) {
    product(id: $id) {
      ${PRODUCT_FIELDS}
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `#graphql
  query ProductDetailVariants($id: ID!, $first: Int!) {
    product(id: $id) {
      id
      variantsCount {
        count
      }
      variants(first: $first) {
        nodes {
          id
          title
          price
          availableForSale
          selectedOptions {
            name
            value
          }
        }
      }
    }
  }
`;

interface ProductsPageResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawShopifyProductNode[];
  };
}

interface SingleProductResponse {
  product: RawShopifyProductNode | null;
}

export interface ProductVariant {
  id: string;
  title: string;
  price: string;
  availableForSale: boolean;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface ProductVariantsResponse {
  product: {
    id: string;
    variantsCount: { count: number } | null;
    variants: { nodes: ProductVariant[] };
  } | null;
}

export interface ProductsPage {
  nodes: RawShopifyProductNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Fetches one page of products for catalog sync, cursor-paginated.
 *
 * `updatedSince`, when provided, is translated into Shopify's search query
 * syntax (`updated_at:>='...'`) so an incremental sync only asks Shopify
 * for products that changed — see services/products/sync.server.ts.
 */
export async function fetchProductsPage(
  client: AdminGraphQLClient,
  options: { after?: string | null; updatedSince?: Date },
): Promise<ProductsPage> {
  const query = options.updatedSince
    ? `updated_at:>='${options.updatedSince.toISOString()}'`
    : undefined;

  const data = await executeAdminGraphQL<ProductsPageResponse>(client, PRODUCTS_PAGE_QUERY, {
    first: PRODUCTS_PAGE_SIZE,
    after: options.after ?? null,
    query,
  });

  return {
    nodes: data.products.nodes,
    hasNextPage: data.products.pageInfo.hasNextPage,
    endCursor: data.products.pageInfo.endCursor,
  };
}

/** Fetches a single product by its Shopify GraphQL ID — used by the
 * webhook-triggered upsert path (services/products/sync.server.ts). Returns
 * `null` if the product no longer exists (already deleted). */
export async function fetchSingleProduct(
  client: AdminGraphQLClient,
  shopifyProductId: string,
): Promise<RawShopifyProductNode | null> {
  const data = await executeAdminGraphQL<SingleProductResponse>(client, SINGLE_PRODUCT_QUERY, {
    id: shopifyProductId,
  });
  return data.product;
}

/** Fetches live variant data for the product detail page. Not persisted —
 * see docs/database.md "Why variants aren't stored locally". */
export async function fetchProductVariants(
  client: AdminGraphQLClient,
  shopifyProductId: string,
  first = 25,
): Promise<{ count: number; variants: ProductVariant[] } | null> {
  const data = await executeAdminGraphQL<ProductVariantsResponse>(client, PRODUCT_VARIANTS_QUERY, {
    id: shopifyProductId,
    first,
  });
  if (!data.product) return null;
  return {
    count: data.product.variantsCount?.count ?? data.product.variants.nodes.length,
    variants: data.product.variants.nodes,
  };
}
