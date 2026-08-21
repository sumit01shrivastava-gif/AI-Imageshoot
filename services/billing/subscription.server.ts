/**
 * Billing orchestration — the service entry point routes/webhooks call.
 * Wraps `services/billing/shopify-billing-provider.server.ts` (the raw
 * Shopify Billing API calls) with this app's own state
 * (`ShopSubscription`) and idempotent audit trail (`BillingEvent`).
 * Mirrors every other domain's "service entry point re-verifies shop
 * ownership, repository does the actual persistence" shape — see
 * CLAUDE.md "Security requirements".
 */
import type { AuthContext } from "../../lib/auth/types";
import type { AdminGraphQLClient } from "../shopify/graphql.server";
import { PLANS, PLAN_ORDER, DEFAULT_PLAN_ID, getPlanDefinition, type PlanDefinition } from "./plans";
import { requestSubscription, cancelSubscription, ShopifyBillingError } from "./shopify-billing-provider.server";
import { getShopSubscription, upsertShopSubscription, findShopSubscriptionByShopifyId } from "../../db/repositories/shop-subscription.repository";
import { recordBillingEvent } from "../../db/repositories/billing-event.repository";
import { getPlan } from "../usage/entitlement.server";
import type { PlanId, SubscriptionStatus } from "@prisma/client";
import { logger } from "../../lib/logging/logger.server";

export class InvalidPlanChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlanChangeError";
  }
}

export interface BillingSnapshot {
  currentPlan: PlanDefinition;
  status: SubscriptionStatus | "NONE";
  currentPeriodEnd: Date | null;
  allPlans: PlanDefinition[];
  planOrder: PlanId[];
}

/** Everything /app/billing's loader needs — the shop's resolved current
 * plan (via services/usage/entitlement.server.ts's `getPlan`, the same
 * function every credit check uses, so this page can never show a plan
 * different from what's actually being enforced), its subscription
 * status, and the full catalog to render Upgrade/Downgrade options. */
export async function getBillingSnapshot(context: AuthContext): Promise<BillingSnapshot> {
  const [currentPlan, subscriptionRow] = await Promise.all([getPlan(context.shop), getShopSubscription(context.shop)]);
  return {
    currentPlan,
    status: subscriptionRow?.status ?? "NONE",
    currentPeriodEnd: subscriptionRow?.currentPeriodEnd ?? null,
    allPlans: PLAN_ORDER.map((id) => PLANS[id]),
    planOrder: [...PLAN_ORDER],
  };
}

/**
 * Starts (or changes to) a paid plan — creates a Shopify-hosted
 * subscription confirmation request and returns its `confirmationUrl`
 * for the route to redirect the merchant to. Requesting the plan the
 * shop is ALREADY on is rejected (`InvalidPlanChangeError`) — nothing to
 * confirm. Downgrading to FREE never calls Shopify at all — see
 * `cancelToFree`. Must be called with the per-request authenticated
 * `admin` client (see shopify-billing-provider.server.ts's doc comment).
 */
export async function requestPlanChange(context: AuthContext, admin: AdminGraphQLClient, planId: PlanId, returnUrl: string): Promise<{ confirmationUrl: string }> {
  if (planId === "FREE") {
    throw new InvalidPlanChangeError("Use cancelToFree to move to the Free plan.");
  }
  const current = await getShopSubscription(context.shop);
  if (current?.planId === planId && current.status === "ACTIVE") {
    throw new InvalidPlanChangeError(`This shop is already on the ${getPlanDefinition(planId).name} plan.`);
  }

  const plan = getPlanDefinition(planId);
  const { confirmationUrl, shopifySubscriptionId } = await requestSubscription(admin, { plan, returnUrl });

  // PENDING until the merchant actually confirms on Shopify's hosted
  // page and the app_subscriptions/update webhook lands — see
  // webhooks.app_subscriptions.update.tsx. Recorded as an idempotent
  // BillingEvent keyed on the new Shopify subscription id, so a retried
  // route action (e.g. a duplicate form submit before the redirect
  // completes) never records the request twice.
  await upsertShopSubscription(context.shop, { planId, status: "PENDING", shopifySubscriptionId });
  await recordBillingEvent({
    shop: context.shop,
    type: "SUBSCRIPTION_REQUESTED",
    shopifySubscriptionId,
    fromPlanId: current?.planId ?? DEFAULT_PLAN_ID,
    toPlanId: planId,
    idempotencyKey: `subscription-requested:${shopifySubscriptionId}`,
  });

  return { confirmationUrl };
}

/** Moves a shop to FREE — cancels any real Shopify subscription first
 * (best-effort; a subscription that's already gone/cancelled on
 * Shopify's side is not an error here), then clears local state. Never
 * calls `appSubscriptionCreate` for FREE (it isn't a real Shopify
 * subscription — $0/mo has nothing to confirm). */
export async function cancelToFree(context: AuthContext, admin: AdminGraphQLClient): Promise<void> {
  const current = await getShopSubscription(context.shop);
  if (current?.shopifySubscriptionId && current.status === "ACTIVE") {
    try {
      await cancelSubscription(admin, current.shopifySubscriptionId);
    } catch (error) {
      // Logged, not rethrown — the merchant's intent ("stop paying") must
      // still take effect locally even if Shopify's own cancel call
      // fails transiently; the shop is moved to FREE either way, and a
      // stale Shopify-side subscription with no matching local record
      // is the safer failure direction (never double-charge, worst case
      // is an already-cancelled-locally subscription still shows active
      // on Shopify's dashboard until reconciled).
      logger.warn("billing.cancel_to_free.shopify_cancel_failed", {
        shop: context.shop,
        detail: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  await upsertShopSubscription(context.shop, {
    planId: "FREE",
    status: "ACTIVE",
    shopifySubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
  });
  await recordBillingEvent({
    shop: context.shop,
    type: "SUBSCRIPTION_CANCELLED",
    fromPlanId: current?.planId ?? null,
    toPlanId: "FREE",
    idempotencyKey: `cancel-to-free:${context.shop}:${Date.now()}`,
  });
}

/**
 * Syncs local `ShopSubscription` state from a Shopify
 * `app_subscriptions/update` webhook payload — the ONLY place a
 * subscription is ever marked ACTIVE (Shopify's own confirmation is the
 * source of truth, never the merchant-initiated request above, which
 * only ever sets PENDING). Idempotent: `idempotencyKey` is derived from
 * the webhook's own subscription id + status + updated-at, so Shopify
 * redelivering the identical event is a safe, detectable no-op (see
 * `recordBillingEvent`'s doc comment) rather than double-processing.
 */
export async function syncSubscriptionFromWebhook(
  shop: string,
  payload: { admin_graphql_api_id: string; name: string; status: string; admin_graphql_api_shop?: string },
  idempotencyKey: string,
): Promise<{ wasNew: boolean }> {
  const { event, wasNew } = await recordBillingEvent({
    shop,
    type: "WEBHOOK_RECEIVED",
    shopifySubscriptionId: payload.admin_graphql_api_id,
    idempotencyKey,
    metadata: { name: payload.name, status: payload.status },
  });
  if (!wasNew) {
    logger.info("billing.webhook.duplicate_ignored", { shop, idempotencyKey });
    return { wasNew: false };
  }
  void event;

  const status = mapShopifySubscriptionStatus(payload.status);
  const existing = await findShopSubscriptionByShopifyId(payload.admin_graphql_api_id);
  const planId = existing?.planId ?? matchPlanIdByName(payload.name) ?? DEFAULT_PLAN_ID;

  await upsertShopSubscription(shop, {
    planId: status === "ACTIVE" ? planId : (existing?.planId ?? DEFAULT_PLAN_ID),
    status,
    shopifySubscriptionId: payload.admin_graphql_api_id,
  });

  await recordBillingEvent({
    shop,
    type: status === "ACTIVE" ? "SUBSCRIPTION_ACTIVATED" : status === "CANCELLED" ? "SUBSCRIPTION_CANCELLED" : status === "DECLINED" ? "SUBSCRIPTION_DECLINED" : "SUBSCRIPTION_EXPIRED",
    shopifySubscriptionId: payload.admin_graphql_api_id,
    toPlanId: planId,
    idempotencyKey: `${idempotencyKey}:applied`,
  });

  return { wasNew: true };
}

function mapShopifySubscriptionStatus(shopifyStatus: string): SubscriptionStatus {
  const normalized = shopifyStatus.toUpperCase();
  if (normalized === "ACTIVE" || normalized === "PENDING" || normalized === "CANCELLED" || normalized === "DECLINED" || normalized === "EXPIRED" || normalized === "FROZEN") {
    return normalized;
  }
  return "PENDING";
}

/** Matches a Shopify subscription's `name` (this app sets it to the
 * plan's own `PlanDefinition.name` when requesting — see
 * `requestPlanChange`) back to a `PlanId`. Falls back to null (caller
 * defaults to FREE) for a name that doesn't match any current plan —
 * e.g. a stale subscription created under a since-renamed/removed plan. */
function matchPlanIdByName(name: string): PlanId | null {
  const match = PLAN_ORDER.find((id) => PLANS[id].name === name);
  return match ?? null;
}

export { ShopifyBillingError };
