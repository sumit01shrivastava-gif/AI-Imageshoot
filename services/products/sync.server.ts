/**
 * Catalog synchronization orchestration.
 *
 * Two entry points:
 *   - `runCatalogSync` — full or incremental sync of the whole catalog,
 *     paginated (never loads more than one page into memory at a time —
 *     see CLAUDE.md "Performance").
 *   - `syncSingleProduct` / `removeSyncedProduct` — targeted, single-product
 *     sync, used by the webhook-triggered path (see workers/index.ts and
 *     app/routes/webhooks.products.*).
 *
 * Both run against an `AdminGraphQLClient` the caller already has — a
 * request-scoped one (`requireAdminContext`) for the manual "Sync now"
 * action, or an offline one (`unauthenticated.admin(shop)`) for
 * webhook/background sync. This module never constructs a Shopify client
 * itself (see services/shopify/ "Architecture principles").
 */
import type { AdminGraphQLClient } from "../shopify/graphql.server";
import { ShopifyGraphQLError } from "../shopify/graphql.server";
import { fetchProductsPage, fetchSingleProduct } from "./shopify-queries.server";
import { mapProductNode } from "./mapping";
import { upsertSyncedProduct, deleteSyncedProduct } from "../../db/repositories/shopify-product.repository";
import {
  getSyncState,
  markSyncStarted,
  markSyncSucceeded,
  markSyncFailed,
} from "../../db/repositories/shop-sync-state.repository";
import { logger } from "../../lib/logging/logger.server";
import type { SyncMode, SyncResult } from "./types";

/** Merchant-safe error summary — never the raw error message/stack, which
 * may contain Shopify response detail (see CLAUDE.md "Safe error
 * handling"). */
const GENERIC_SYNC_FAILURE_MESSAGE =
  "Catalog sync failed. This is usually temporary — try syncing again in a few minutes.";

/**
 * Runs a full or incremental catalog sync for one shop, paginating through
 * every matching product and upserting each page as it arrives (a page is
 * never held in memory longer than it takes to upsert it — safe for
 * catalogs of any size, per CLAUDE.md "Performance").
 *
 * `mode: "incremental"` scopes the Shopify query to `updated_at >=` the
 * shop's last successful sync; falls back to a full sync if there isn't
 * one yet.
 */
export async function runCatalogSync(
  client: AdminGraphQLClient,
  shop: string,
  mode: SyncMode,
): Promise<SyncResult> {
  await markSyncStarted(shop);

  const previousState = mode === "incremental" ? await getSyncState(shop) : null;
  const updatedSince = previousState?.lastSyncedAt ?? undefined;
  const effectiveMode: SyncMode = updatedSince ? "incremental" : "full";

  let after: string | null | undefined;
  let hasNextPage = true;
  let productsSynced = 0;
  let pagesFetched = 0;

  try {
    while (hasNextPage) {
      const page = await fetchProductsPage(client, { after, updatedSince });
      pagesFetched += 1;

      for (const node of page.nodes) {
        const product = mapProductNode(node);
        await upsertSyncedProduct(shop, product);
        productsSynced += 1;
      }

      hasNextPage = page.hasNextPage;
      after = page.endCursor;
    }

    await markSyncSucceeded(shop);
    logger.info("products.sync.completed", { shop, mode: effectiveMode, productsSynced, pagesFetched });
    return { mode: effectiveMode, productsSynced, pagesFetched };
  } catch (error) {
    const detail = error instanceof ShopifyGraphQLError ? error.message : "unexpected error";
    logger.error("products.sync.failed", { shop, mode: effectiveMode, productsSynced, pagesFetched, detail });
    await markSyncFailed(shop, GENERIC_SYNC_FAILURE_MESSAGE);
    throw error;
  }
}

/** Upserts (or, if Shopify no longer has it, deletes) exactly one product
 * — the webhook-triggered path. Idempotent and safe to run more than once
 * for the same product (see app/routes/webhooks.products.*). */
export async function syncSingleProduct(
  client: AdminGraphQLClient,
  shop: string,
  shopifyProductId: string,
): Promise<void> {
  const node = await fetchSingleProduct(client, shopifyProductId);

  if (!node) {
    // Product was deleted (or made inaccessible) between the webhook firing
    // and this fetch running — treat the same as a delete webhook.
    await deleteSyncedProduct(shop, shopifyProductId);
    return;
  }

  const product = mapProductNode(node);
  await upsertSyncedProduct(shop, product);
}

/** Removes one product from the local catalog — the products/delete
 * webhook path. Idempotent (see db/repositories/shopify-product.repository.ts). */
export async function removeSyncedProduct(shop: string, shopifyProductId: string): Promise<void> {
  await deleteSyncedProduct(shop, shopifyProductId);
}
