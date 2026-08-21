/**
 * Shop data redaction — backs the mandatory `shop/redact` GDPR compliance
 * webhook every public Shopify app must implement (see
 * https://shopify.dev/docs/apps/build/privacy-law-compliance and
 * app/routes/webhooks.shop.redact.tsx). Shopify calls this ~48 hours
 * after a shop uninstalls the app; this permanently deletes every row
 * this app holds for that shop.
 *
 * Deliberately lives here rather than as one function per domain
 * repository — a cross-cutting, shop-wide bulk deletion spanning every
 * domain model is a fundamentally different kind of operation than a
 * repository's normal single-resource CRUD, and scattering one
 * `deleteAllForShop` export across a dozen repository files would obscure
 * the one place that actually needs to reason about the full picture
 * (which tables exist, and in what order they're safe to clear). Uses
 * `prisma` directly for that reason, mirroring how a Prisma migration
 * itself touches many tables at once — this is the one legitimate
 * exception to "services call repositories, not Prisma directly".
 *
 * Deletion order matters only where a table has no `onDelete: Cascade`
 * relation clearing it automatically: `StoreVisualJob` (nothing cascades
 * into it — it has zero required product references, unlike
 * `GenerationJob`/`ProcessingJob`), `GenerationBatch`/`ProcessingBatch`
 * (their jobs `SetNull` on delete rather than cascading, so they'd
 * otherwise survive as empty shells), and `ImageSelection` (its own
 * `ImageSelectionItem` rows cascade away once the underlying product/
 * media is deleted, but the parent `ImageSelection` row itself has no FK
 * forcing its own removal). Every other model with a `shop` column
 * (`GenerationResult`/`ProcessingResult`/`StoreVisualResult`/
 * `ShopifyProductMedia`/`ProductIntelligence`/`ImageSelectionItem`/
 * `StoreVisualJobProduct`) already cascades away once its owning
 * `ShopifyProduct` or job row is deleted — deleting it here too is a
 * harmless no-op, not a correctness requirement, and is done anyway so
 * this function is correct even if a future migration changes a cascade
 * rule out from under this assumption.
 */
import prisma from "../../db/client.server";
import { logger } from "../../lib/logging/logger.server";

export interface ShopRedactionSummary {
  shop: string;
  deletedCounts: Record<string, number>;
}

/** Permanently deletes every row this app holds for `shop`. Idempotent —
 * safe to call more than once (e.g. a redelivered webhook): a table with
 * nothing left to delete just reports a 0 count. Never throws for "shop
 * already had no data" — only a genuine database error propagates. */
export async function redactShopData(shop: string): Promise<ShopRedactionSummary> {
  const deletedCounts: Record<string, number> = {};

  const run = async (label: string, fn: () => Promise<{ count: number }>) => {
    const result = await fn();
    deletedCounts[label] = result.count;
  };

  // Rows with no automatic cascade clearing them — deleted explicitly,
  // in an order that doesn't actually matter for correctness (see module
  // doc comment) but is ordered leaf-to-root for readability.
  await run("storeVisualResult", () => prisma.storeVisualResult.deleteMany({ where: { shop } }));
  await run("storeVisualJobProduct", () => prisma.storeVisualJobProduct.deleteMany({ where: { storeVisualJob: { shop } } }));
  await run("storeVisualJob", () => prisma.storeVisualJob.deleteMany({ where: { shop } }));

  await run("generationBatch", () => prisma.generationBatch.deleteMany({ where: { shop } }));
  await run("processingBatch", () => prisma.processingBatch.deleteMany({ where: { shop } }));

  // Cascades away GenerationJob/ProcessingJob/ShopifyProductMedia/
  // ProductIntelligence/ImageSelectionItem (and their own results) —
  // deleting the product is what actually clears most of a shop's data.
  await run("shopifyProduct", () => prisma.shopifyProduct.deleteMany({ where: { shop } }));

  // Defensive — already covered by the cascades above under normal
  // operation, kept explicit for the reason in the module doc comment.
  await run("generationResult", () => prisma.generationResult.deleteMany({ where: { shop } }));
  await run("generationJob", () => prisma.generationJob.deleteMany({ where: { shop } }));
  await run("processingResult", () => prisma.processingResult.deleteMany({ where: { shop } }));
  await run("processingJob", () => prisma.processingJob.deleteMany({ where: { shop } }));
  await run("imageSelectionItem", () => prisma.imageSelectionItem.deleteMany({ where: { selection: { shop } } }));

  await run("imageSelection", () => prisma.imageSelection.deleteMany({ where: { shop } }));
  await run("brandStylePreset", () => prisma.brandStylePreset.deleteMany({ where: { shop } }));
  await run("shopSettings", () => prisma.shopSettings.deleteMany({ where: { shop } }));
  await run("shopSyncState", () => prisma.shopSyncState.deleteMany({ where: { shop } }));
  // Also handled by webhooks.app.uninstalled.tsx — repeated here so
  // shop/redact is correct even if that webhook was somehow missed.
  await run("session", () => prisma.session.deleteMany({ where: { shop } }));

  logger.info("shopify.shop_redacted", { shop, deletedCounts });
  return { shop, deletedCounts };
}
