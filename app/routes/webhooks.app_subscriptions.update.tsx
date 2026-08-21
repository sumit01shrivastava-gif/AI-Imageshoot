/**
 * Keeps `ShopSubscription` in sync with Shopify's own record of a
 * merchant's subscription — see services/billing/subscription.server.ts's
 * `syncSubscriptionFromWebhook` for the actual sync logic; this route is
 * just verification + payload shape + idempotency-key derivation, same
 * division of responsibility as every other webhook route (see
 * webhooks.products.update.tsx).
 *
 * Verified via `authenticate.webhook` (HMAC + shop, same as every other
 * webhook route — see CLAUDE.md "Webhook handlers"). Idempotent:
 * `syncSubscriptionFromWebhook`'s `idempotencyKey` is derived from the
 * subscription id + status + this delivery's own updated_at, so Shopify
 * redelivering the identical event is a safe no-op, never a duplicate
 * plan change or a double credit-allowance reset.
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncSubscriptionFromWebhook } from "../../services/billing/subscription.server";
import { logger } from "../../lib/logging/logger.server";

interface AppSubscriptionsUpdatePayload {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
    updated_at?: string;
  };
}

function isPayload(value: unknown): value is AppSubscriptionsUpdatePayload {
  return typeof value === "object" && value !== null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  logger.info("shopify.webhook_received", { shop, topic });

  const subscriptionId = isPayload(payload) ? payload.app_subscription?.admin_graphql_api_id : undefined;
  const status = isPayload(payload) ? payload.app_subscription?.status : undefined;
  if (!subscriptionId || !status) {
    logger.warn("webhooks.app_subscriptions_update.malformed_payload", { shop, topic });
    return new Response();
  }

  const subscription = (payload as AppSubscriptionsUpdatePayload).app_subscription!;
  const idempotencyKey = `app_subscriptions/update:${subscriptionId}:${status}:${subscription.updated_at ?? "unknown"}`;

  await syncSubscriptionFromWebhook(
    shop,
    {
      admin_graphql_api_id: subscriptionId,
      name: subscription.name ?? "",
      status,
    },
    idempotencyKey,
  );

  return new Response();
};
