import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueueCatalogSync } from "../../services/products/sync-queue.server";
import { extractProductGid } from "../../services/products/webhook-payload";
import { logger } from "../../lib/logging/logger.server";

/**
 * Keeps the local catalog in sync with newly created Shopify products.
 *
 * Verified via `authenticate.webhook` (HMAC), shop-scoped from the verified
 * payload (never a client-supplied value), and idempotent: this only
 * enqueues a `"catalog-sync"` job with a deterministic job id (see
 * services/products/sync-job.server.ts) — the actual upsert, which is
 * itself a safe-upsert, runs in the worker process. Safe to receive the
 * same event more than once.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const shopifyProductId = extractProductGid(payload);
  if (!shopifyProductId) {
    logger.warn("webhooks.products_create.missing_id", { shop, topic });
    return new Response();
  }

  await enqueueCatalogSync({ type: "product-upsert", shop, shopifyProductId });

  return new Response();
};
