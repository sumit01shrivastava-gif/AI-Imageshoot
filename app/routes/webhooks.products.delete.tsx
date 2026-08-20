import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueueCatalogSync } from "../../services/products/sync-queue.server";
import { extractProductGid } from "../../services/products/webhook-payload";
import { logger } from "../../lib/logging/logger.server";

/**
 * Removes a product (and, by cascade, its media and any selection items
 * referencing it) from the local catalog when it's deleted in Shopify. See
 * webhooks.products.create.tsx for verification/idempotency notes —
 * identical here; the delete itself is a `deleteMany`, a no-op if the
 * product is already gone locally.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const shopifyProductId = extractProductGid(payload);
  if (!shopifyProductId) {
    logger.warn("webhooks.products_delete.missing_id", { shop, topic });
    return new Response();
  }

  await enqueueCatalogSync({ type: "product-delete", shop, shopifyProductId });

  return new Response();
};
