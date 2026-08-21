/**
 * Mandatory GDPR compliance webhook — `shop/redact` (see
 * https://shopify.dev/docs/apps/build/privacy-law-compliance). Shopify
 * sends this ~48 hours after a shop uninstalls the app; this app must
 * delete the shop's data by then. Delegates to
 * services/shopify/shop-redaction.server.ts's `redactShopData`, which
 * deletes every row this app holds for the shop — see that file's doc
 * comment for the full table list and why deletion order is handled the
 * way it is.
 *
 * Idempotent — see `redactShopData`'s doc comment — so a redelivered
 * webhook (Shopify retries on a non-2xx response) is safe to process
 * twice.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactShopData } from "../../services/shopify/shop-redaction.server";
import { logger } from "../../lib/logging/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  logger.info("shopify.compliance_webhook_received", { shop, topic });
  await redactShopData(shop);
  return new Response();
};
