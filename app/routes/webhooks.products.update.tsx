import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueueCatalogSync } from "../../services/products/sync-queue.server";
import { extractProductGid } from "../../services/products/webhook-payload";
import { logger } from "../../lib/logging/logger.server";

/**
 * Keeps the local catalog in sync with Shopify product updates (title,
 * status, media, etc. changes). See webhooks.products.create.tsx for the
 * verification/idempotency notes — identical here.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const shopifyProductId = extractProductGid(payload);
  if (!shopifyProductId) {
    logger.warn("webhooks.products_update.missing_id", { shop, topic });
    return new Response();
  }

  await enqueueCatalogSync({ type: "product-upsert", shop, shopifyProductId });

  return new Response();
};
