/**
 * Staleness detection — pure, no I/O.
 *
 * Product Intelligence has no persisted "STALE" status (see
 * prisma/schema.prisma's `IntelligenceStatus` enum comment and
 * docs/product-intelligence.md "Staleness"). Instead, a READY profile is
 * considered stale — at read time — when the product's own
 * `shopifyUpdatedAt` (Shopify's timestamp, only bumped when a merchant
 * actually edits something) has moved past the timestamp recorded when
 * the profile was last analyzed.
 *
 * Deliberately NOT based on our local `ShopifyProduct.updatedAt` /
 * `syncedAt`: those change on every catalog resync regardless of whether
 * anything relevant to intelligence actually changed, which would mark
 * every profile stale almost immediately and make the signal useless.
 */

export interface StalenessCheckInput {
  /** The profile's status — only a READY profile can be stale; anything
   * else (PENDING/PROCESSING/FAILED) has its own state already. */
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  /** `ProductIntelligence.sourceShopifyUpdatedAt` — null means "never
   * successfully analyzed", never stale (there's nothing to go stale). */
  sourceShopifyUpdatedAt: Date | null;
}

export interface StalenessCheckProduct {
  /** `ShopifyProduct.shopifyUpdatedAt`. */
  shopifyUpdatedAt: Date;
}

/**
 * True only for a READY profile whose product has since been updated on
 * Shopify. A profile that was never successfully analyzed (no
 * `sourceShopifyUpdatedAt`) is not "stale" — it's simply not analyzed.
 */
export function isIntelligenceStale(
  intelligence: StalenessCheckInput | null | undefined,
  product: StalenessCheckProduct,
): boolean {
  if (!intelligence || intelligence.status !== "READY" || !intelligence.sourceShopifyUpdatedAt) {
    return false;
  }
  return product.shopifyUpdatedAt.getTime() > intelligence.sourceShopifyUpdatedAt.getTime();
}

/** The five states the Phase 2 UI distinguishes (see
 * app/routes/app.products.$id.tsx) — combines the persisted `status` with
 * the derived staleness check above into one display-ready value. */
export type IntelligenceDisplayState = "not_analyzed" | "analyzing" | "ready" | "stale" | "failed";

export function getIntelligenceDisplayState(
  intelligence: StalenessCheckInput | null | undefined,
  product: StalenessCheckProduct,
): IntelligenceDisplayState {
  if (!intelligence) return "not_analyzed";
  if (intelligence.status === "PENDING") return "not_analyzed";
  if (intelligence.status === "PROCESSING") return "analyzing";
  if (intelligence.status === "FAILED") return "failed";
  // status === "READY"
  return isIntelligenceStale(intelligence, product) ? "stale" : "ready";
}
