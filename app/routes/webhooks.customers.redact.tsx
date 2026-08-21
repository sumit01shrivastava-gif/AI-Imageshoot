/**
 * Mandatory GDPR compliance webhook — `customers/redact` (see
 * https://shopify.dev/docs/apps/build/privacy-law-compliance). Same
 * reasoning as webhooks.customers.data_request.tsx: this app holds no
 * customer data (no `Customer`/order/PII model exists — see
 * prisma/schema.prisma), so there is nothing to redact. Acknowledging
 * with 200 is the correct, complete response.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../../lib/logging/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  logger.info("shopify.compliance_webhook_received", { shop, topic, note: "no customer data held by this app" });
  return new Response();
};
