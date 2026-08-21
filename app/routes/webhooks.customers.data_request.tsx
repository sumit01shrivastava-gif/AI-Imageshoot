/**
 * Mandatory GDPR compliance webhook — `customers/data_request` (see
 * https://shopify.dev/docs/apps/build/privacy-law-compliance). HMAC/shop
 * verified via `authenticate.webhook` (same as every other webhook route
 * — see CLAUDE.md "Shopify API rules").
 *
 * This app never stores customer data — its entire data model is
 * products, their images, and this app's own generated assets (see
 * prisma/schema.prisma: no `Customer`/order/PII model exists anywhere).
 * There is nothing to compile or return for a data-subject access
 * request; acknowledging with 200 and logging receipt (for an audit
 * trail, never the payload's PII fields themselves — see CLAUDE.md "No
 * sensitive values in logs") is the correct, complete response.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../../lib/logging/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  logger.info("shopify.compliance_webhook_received", { shop, topic, note: "no customer data held by this app" });
  return new Response();
};
