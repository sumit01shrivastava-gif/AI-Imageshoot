/**
 * Unit tests: services/billing/shopify-billing-provider.server.ts — the
 * raw Shopify Billing API calls, with the GraphQL client faked (no real
 * network call — mirrors tests/unit/shopify/publish-media.test.ts's
 * pattern for the exact same reason).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import type { AdminGraphQLClient } from "../../../services/shopify/graphql.server";
import { getPlanDefinition } from "../../../services/billing/plans";

function fakeAdmin(responseBody: unknown, status = 200): AdminGraphQLClient {
  return {
    graphql: vi.fn(async () => new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } })),
  };
}

describe("requestSubscription", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    resetEnvCacheForTests();
  });
  afterEach(() => {
    resetEnvCacheForTests();
  });

  it("returns the confirmationUrl and subscription id on success", async () => {
    const admin = fakeAdmin({
      data: {
        appSubscriptionCreate: {
          appSubscription: { id: "gid://shopify/AppSubscription/1", status: "PENDING" },
          confirmationUrl: "https://admin.shopify.com/confirm/1",
          userErrors: [],
        },
      },
    });
    const { requestSubscription } = await import("../../../services/billing/shopify-billing-provider.server");

    const result = await requestSubscription(admin, { plan: getPlanDefinition("STARTER"), returnUrl: "https://app.example.com/billing" });
    expect(result.confirmationUrl).toBe("https://admin.shopify.com/confirm/1");
    expect(result.shopifySubscriptionId).toBe("gid://shopify/AppSubscription/1");
  });

  it("sends test: true outside production (NODE_ENV=test)", async () => {
    const admin = fakeAdmin({
      data: {
        appSubscriptionCreate: {
          appSubscription: { id: "gid://shopify/AppSubscription/1", status: "PENDING" },
          confirmationUrl: "https://admin.shopify.com/confirm/1",
          userErrors: [],
        },
      },
    });
    const { requestSubscription } = await import("../../../services/billing/shopify-billing-provider.server");
    await requestSubscription(admin, { plan: getPlanDefinition("STARTER"), returnUrl: "https://app.example.com/billing" });

    const call = (admin.graphql as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]?.variables?.test).toBe(true);
  });

  it("throws ShopifyBillingError when Shopify returns a userError", async () => {
    const admin = fakeAdmin({
      data: {
        appSubscriptionCreate: {
          appSubscription: null,
          confirmationUrl: null,
          userErrors: [{ field: ["returnUrl"], message: "Invalid return URL" }],
        },
      },
    });
    const { requestSubscription, ShopifyBillingError } = await import("../../../services/billing/shopify-billing-provider.server");

    await expect(requestSubscription(admin, { plan: getPlanDefinition("STARTER"), returnUrl: "not-a-url" })).rejects.toBeInstanceOf(
      ShopifyBillingError,
    );
  });

  it("throws ShopifyBillingError when the response is missing expected fields", async () => {
    const admin = fakeAdmin({ data: { appSubscriptionCreate: { appSubscription: null, confirmationUrl: null, userErrors: [] } } });
    const { requestSubscription, ShopifyBillingError } = await import("../../../services/billing/shopify-billing-provider.server");

    await expect(
      requestSubscription(admin, { plan: getPlanDefinition("STARTER"), returnUrl: "https://app.example.com/billing" }),
    ).rejects.toBeInstanceOf(ShopifyBillingError);
  });
});

describe("cancelSubscription", () => {
  it("resolves without throwing on success", async () => {
    const admin = fakeAdmin({
      data: { appSubscriptionCancel: { appSubscription: { id: "gid://shopify/AppSubscription/1", status: "CANCELLED" }, userErrors: [] } },
    });
    const { cancelSubscription } = await import("../../../services/billing/shopify-billing-provider.server");
    await expect(cancelSubscription(admin, "gid://shopify/AppSubscription/1")).resolves.toBeUndefined();
  });

  it("treats an 'already cancelled/not found' userError as a safe no-op, not an error", async () => {
    const admin = fakeAdmin({
      data: { appSubscriptionCancel: { appSubscription: null, userErrors: [{ field: null, message: "Subscription not found" }] } },
    });
    const { cancelSubscription } = await import("../../../services/billing/shopify-billing-provider.server");
    await expect(cancelSubscription(admin, "gid://shopify/AppSubscription/gone")).resolves.toBeUndefined();
  });

  it("throws ShopifyBillingError for a genuine, non-'already gone' userError", async () => {
    const admin = fakeAdmin({
      data: { appSubscriptionCancel: { appSubscription: null, userErrors: [{ field: null, message: "Internal error" }] } },
    });
    const { cancelSubscription, ShopifyBillingError } = await import("../../../services/billing/shopify-billing-provider.server");
    await expect(cancelSubscription(admin, "gid://shopify/AppSubscription/1")).rejects.toBeInstanceOf(ShopifyBillingError);
  });
});

describe("getCurrentSubscription", () => {
  it("returns the first active subscription", async () => {
    const admin = fakeAdmin({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [{ id: "gid://shopify/AppSubscription/1", name: "Starter", status: "ACTIVE", currentPeriodEnd: "2026-09-01T00:00:00Z", test: true }],
        },
      },
    });
    const { getCurrentSubscription } = await import("../../../services/billing/shopify-billing-provider.server");
    const result = await getCurrentSubscription(admin);
    expect(result?.name).toBe("Starter");
  });

  it("returns null when there are no active subscriptions", async () => {
    const admin = fakeAdmin({ data: { currentAppInstallation: { activeSubscriptions: [] } } });
    const { getCurrentSubscription } = await import("../../../services/billing/shopify-billing-provider.server");
    expect(await getCurrentSubscription(admin)).toBeNull();
  });
});
