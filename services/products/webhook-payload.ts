/**
 * Pure helper: extract a product's Shopify GraphQL ID from a
 * products/create|update|delete webhook payload.
 *
 * We deliberately do NOT trust the rest of the REST-shaped webhook payload
 * for product data (title, images, etc.) — CLAUDE.md requires GraphQL for
 * all new functionality, so the webhook handlers use this id only to
 * re-fetch the product via the Admin GraphQL API (see
 * services/products/sync.server.ts). Most payloads include
 * `admin_graphql_api_id` directly; if it's missing, it's derived from the
 * numeric `id` (Shopify's standard GID format for a Product).
 */
export function extractProductGid(payload: Record<string, unknown>): string | null {
  const gid = payload["admin_graphql_api_id"];
  if (typeof gid === "string" && gid.startsWith("gid://shopify/Product/")) {
    return gid;
  }

  const id = payload["id"];
  if (typeof id === "number" && Number.isFinite(id)) {
    return `gid://shopify/Product/${id}`;
  }
  if (typeof id === "string" && /^\d+$/.test(id)) {
    return `gid://shopify/Product/${id}`;
  }

  return null;
}
