/**
 * Billing — the merchant-facing subscription/credit management page
 * (Part 9): current plan, remaining credits, monthly allowance, billing
 * status, and Upgrade/Downgrade/Manage actions. See docs/billing.md.
 *
 * Every plan/credit number shown here is read server-side from
 * services/usage/entitlement.server.ts / services/billing/subscription.server.ts
 * — never trust a client-supplied plan or credit amount (CLAUDE.md
 * "Security requirements").
 */
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";

import { requireAdminContext } from "../../services/shopify";
import { getBillingSnapshot, requestPlanChange, cancelToFree, InvalidPlanChangeError } from "../../services/billing/subscription.server";
import { ShopifyBillingError } from "../../services/billing/shopify-billing-provider.server";
import { getRemainingCredits } from "../../services/usage/entitlement.server";
import { PLAN_ORDER } from "../../services/billing/plans";
import { logger } from "../../lib/logging/logger.server";
import { getEnv } from "../../lib/validation/env.server";
import type { PlanId } from "@prisma/client";

function isValidPlanId(value: string): value is PlanId {
  return (PLAN_ORDER as readonly string[]).includes(value);
}

const STATUS_TONE: Record<string, "success" | "warning" | "critical" | "info"> = {
  ACTIVE: "success",
  PENDING: "warning",
  FROZEN: "critical",
  CANCELLED: "info",
  DECLINED: "critical",
  EXPIRED: "critical",
  NONE: "info",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const [snapshot, remainingCredits] = await Promise.all([getBillingSnapshot(context), getRemainingCredits(context.shop)]);
  return { snapshot, remainingCredits };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context, admin } = await requireAdminContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const returnUrl = new URL("/app/billing", getEnv().SHOPIFY_APP_URL).toString();

  try {
    if (intent === "change-plan") {
      const planId = formData.get("planId");
      if (typeof planId !== "string" || !isValidPlanId(planId)) {
        return { ok: false as const, error: "Unknown plan." };
      }
      if (planId === "FREE") {
        await cancelToFree(context, admin);
        return { ok: true as const, confirmationUrl: null };
      }
      const { confirmationUrl } = await requestPlanChange(context, admin, planId, returnUrl);
      return { ok: true as const, confirmationUrl };
    }
    if (intent === "cancel") {
      await cancelToFree(context, admin);
      return { ok: true as const, confirmationUrl: null };
    }
    return { ok: false as const, error: "Unknown action." };
  } catch (error) {
    if (error instanceof InvalidPlanChangeError) {
      return { ok: false as const, error: error.message };
    }
    if (error instanceof ShopifyBillingError) {
      logger.error("billing.action_failed", { shop: context.shop, detail: error.message });
      return { ok: false as const, error: "Couldn't reach Shopify billing right now. Please try again." };
    }
    logger.error("billing.action_failed", { shop: context.shop, detail: error instanceof Error ? error.message : "unknown error" });
    return { ok: false as const, error: "Something went wrong. Please try again." };
  }
};

export default function Billing() {
  const { snapshot, remainingCredits } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (!fetcher.data) return;
    if (!fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error, { isError: true });
      return;
    }
    if (fetcher.data.confirmationUrl) {
      // Billing confirmation must happen OUTSIDE the embedded iframe —
      // Shopify's documented requirement
      // (https://shopify.dev/docs/apps/launch/billing) — so this breaks
      // out to the top-level window rather than navigating within the
      // app's own iframe.
      window.top!.location.href = fetcher.data.confirmationUrl;
    } else {
      shopify.toast.show("Plan updated.");
    }
  }, [fetcher.data, shopify]);

  const isBusy = fetcher.state !== "idle";
  const currentPlanId = snapshot.currentPlan.id;

  return (
    <s-page heading="Billing">
      <s-section heading="Current plan">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-heading>{snapshot.currentPlan.name}</s-heading>
            <s-badge tone={STATUS_TONE[snapshot.status] ?? "info"}>{snapshot.status === "NONE" ? "Free" : snapshot.status}</s-badge>
          </s-stack>
          <s-text color="subdued">{snapshot.currentPlan.description}</s-text>
          <s-text>
            {remainingCredits} of {snapshot.currentPlan.monthlyCredits} credits remaining this month
          </s-text>
          {snapshot.currentPeriodEnd && (
            <s-text color="subdued">Renews {new Date(snapshot.currentPeriodEnd).toLocaleDateString()}</s-text>
          )}
          {currentPlanId !== "FREE" && (
            <s-button
              variant="tertiary"
              tone="critical"
              disabled={isBusy}
              onClick={() => fetcher.submit({ intent: "cancel" }, { method: "POST" })}
            >
              Cancel and move to Free
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Plans">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
          {snapshot.allPlans.map((plan) => {
            const isCurrent = plan.id === currentPlanId;
            const isUpgrade = snapshot.planOrder.indexOf(plan.id) > snapshot.planOrder.indexOf(currentPlanId);
            return (
              <s-box key={plan.id} padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
                <s-stack direction="block" gap="small-200">
                  <s-heading>{plan.name}</s-heading>
                  <s-text color="subdued">{plan.description}</s-text>
                  <s-text>{plan.priceUsd === 0 ? "Free" : `$${plan.priceUsd}/mo`}</s-text>
                  <s-text color="subdued">{plan.monthlyCredits} credits/month</s-text>
                  <s-text color="subdued">Up to {plan.maxOutputsPerGeneration} outputs per generation</s-text>
                  {isCurrent ? (
                    <s-badge tone="success">Current plan</s-badge>
                  ) : (
                    <s-button
                      variant={isUpgrade ? "primary" : "secondary"}
                      disabled={isBusy}
                      onClick={() => fetcher.submit({ intent: "change-plan", planId: plan.id }, { method: "POST" })}
                    >
                      {isUpgrade ? "Upgrade" : "Downgrade"}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
