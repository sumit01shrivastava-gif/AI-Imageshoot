/**
 * The billing PROVIDER — the one file in this codebase that speaks to
 * Shopify's own Billing API (`appSubscriptionCreate`/`appSubscriptionCancel`/
 * `currentAppInstallation.activeSubscriptions`). Every other billing file
 * (subscription.server.ts, the webhook handler, /app/billing) calls into
 * this one, never into `admin.graphql` directly — mirrors
 * services/shopify/publish-media.server.ts's exact isolation shape (the
 * only other file in this codebase allowed to define a GraphQL mutation
 * — see tests/unit/shopify-scope-safety.test.ts, extended to cover this
 * file too).
 *
 * ## Why Shopify Billing, not a third-party processor (Part 7's
 * explicitly-authorized architecture decision)
 *
 * This is a Shopify EMBEDDED app charging Shopify MERCHANTS for a
 * recurring subscription. Shopify's own Billing API
 * (https://shopify.dev/docs/apps/launch/billing) is:
 *   - the mechanism the Shopify App Store actually requires/expects for
 *     merchant-facing recurring charges — a third-party processor
 *     (Stripe etc.) charging the merchant directly is not how Shopify
 *     app billing works and would not pass App Store review;
 *   - already reachable through infrastructure this app has: the exact
 *     same `executeAdminGraphQL`/`AdminGraphQLClient` transport
 *     services/shopify/publish-media.server.ts already uses (retries,
 *     typed errors, no new dependency);
 *   - gated by the app's Partners/Dev Dashboard billing configuration,
 *     NOT by OAuth `access_scopes` — unlike `productCreateMedia`
 *     (publishing), calling `appSubscriptionCreate` requires no new
 *     scope in shopify.app.toml, so this satisfies CLAUDE.md's "do not
 *     add Shopify write scopes" constraint for this pass by construction,
 *     not by omission.
 * See docs/billing.md "Provider decision" for the full writeup.
 *
 * ## Test mode
 *
 * Every mutation call sets `test: true` unless `NODE_ENV === "production"`
 * — Shopify's own documented mechanism for a subscription that never
 * actually charges the merchant (https://shopify.dev/docs/apps/launch/billing/test-charges).
 * This means every environment except a real production deploy is safe
 * to exercise end-to-end against a real Shopify dev store with zero risk
 * of a real charge.
 */
import { getEnv } from "../../lib/validation/env.server";
import { executeAdminGraphQL, ShopifyGraphQLError, type AdminGraphQLClient } from "../shopify/graphql.server";
import type { PlanDefinition } from "./plans";

export class ShopifyBillingError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "ShopifyBillingError";
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

const APP_SUBSCRIPTION_CREATE_MUTATION = `#graphql
  mutation CreateAppSubscription($name: String!, $returnUrl: URL!, $test: Boolean!, $lineItems: [AppSubscriptionLineItemInput!]!) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
      appSubscription {
        id
        status
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const APP_SUBSCRIPTION_CANCEL_MUTATION = `#graphql
  mutation CancelAppSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CURRENT_SUBSCRIPTIONS_QUERY = `#graphql
  query CurrentAppSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        currentPeriodEnd
        test
      }
    }
  }
`;

interface AppSubscriptionCreateResponse {
  appSubscriptionCreate: {
    appSubscription: { id: string; status: string } | null;
    confirmationUrl: string | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

interface AppSubscriptionCancelResponse {
  appSubscriptionCancel: {
    appSubscription: { id: string; status: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

interface CurrentAppSubscriptionsResponse {
  currentAppInstallation: {
    activeSubscriptions: Array<{ id: string; name: string; status: string; currentPeriodEnd: string | null; test: boolean }>;
  };
}

function isTestMode(): boolean {
  return getEnv().NODE_ENV !== "production";
}

/**
 * Starts a Shopify-hosted subscription confirmation flow for `plan` —
 * the merchant is redirected to `confirmationUrl` to approve the charge
 * on Shopify's own UI; the subscription only becomes ACTIVE once they do
 * (synced back via the `app_subscriptions/update` webhook — see
 * app/routes/webhooks.app_subscriptions.update.tsx). Must be called with
 * the per-REQUEST authenticated `admin` client (not the offline/
 * background one) — this redirect only makes sense inside a live
 * merchant request. Throws `ShopifyBillingError` on any userError or
 * malformed response — never returns a half-valid result.
 */
export async function requestSubscription(
  admin: AdminGraphQLClient,
  input: { plan: PlanDefinition; returnUrl: string },
): Promise<{ confirmationUrl: string; shopifySubscriptionId: string }> {
  try {
    const data = await executeAdminGraphQL<AppSubscriptionCreateResponse>(admin, APP_SUBSCRIPTION_CREATE_MUTATION, {
      name: input.plan.name,
      returnUrl: input.returnUrl,
      test: isTestMode(),
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: input.plan.priceUsd, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    });

    const result = data.appSubscriptionCreate;
    if (result.userErrors.length > 0) {
      throw new ShopifyBillingError(result.userErrors.map((e) => e.message).join("; "));
    }
    if (!result.appSubscription || !result.confirmationUrl) {
      throw new ShopifyBillingError("Shopify did not return a subscription id or confirmation URL.");
    }

    return { confirmationUrl: result.confirmationUrl, shopifySubscriptionId: result.appSubscription.id };
  } catch (error) {
    if (error instanceof ShopifyBillingError) throw error;
    throw new ShopifyBillingError("Failed to start a Shopify subscription request.", { cause: error });
  }
}

/** Cancels an active Shopify subscription. Safe to call on an
 * already-cancelled/nonexistent subscription id — Shopify itself returns
 * a userError in that case, which this maps to a no-op rather than a
 * thrown error (cancelling twice, e.g. a retried request, must not be an
 * error the merchant sees). */
export async function cancelSubscription(admin: AdminGraphQLClient, shopifySubscriptionId: string): Promise<void> {
  try {
    const data = await executeAdminGraphQL<AppSubscriptionCancelResponse>(admin, APP_SUBSCRIPTION_CANCEL_MUTATION, {
      id: shopifySubscriptionId,
    });
    const result = data.appSubscriptionCancel;
    if (result.userErrors.length > 0) {
      const alreadyGone = result.userErrors.some((e) => /not found|already/i.test(e.message));
      if (!alreadyGone) {
        throw new ShopifyBillingError(result.userErrors.map((e) => e.message).join("; "));
      }
    }
  } catch (error) {
    if (error instanceof ShopifyBillingError) throw error;
    throw new ShopifyBillingError("Failed to cancel the Shopify subscription.", { cause: error });
  }
}

/** The shop's currently-active Shopify subscription(s), if any — used to
 * reconcile `ShopSubscription` on demand (e.g. /app/billing's loader),
 * independent of whether a webhook has already arrived. `null` when the
 * shop has no active subscription (FREE plan). */
export async function getCurrentSubscription(
  admin: AdminGraphQLClient,
): Promise<{ id: string; name: string; status: string; currentPeriodEnd: string | null } | null> {
  const data = await executeAdminGraphQL<CurrentAppSubscriptionsResponse>(admin, CURRENT_SUBSCRIPTIONS_QUERY);
  const active = data.currentAppInstallation.activeSubscriptions;
  return active.length > 0 ? active[0] : null;
}

export { ShopifyGraphQLError };
