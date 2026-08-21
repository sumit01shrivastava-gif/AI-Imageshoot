/**
 * Unit test: app/routes/webhooks.app_subscriptions.update.tsx — payload
 * validation and delegation to services/billing/subscription.server.ts's
 * `syncSubscriptionFromWebhook`. `authenticate.webhook` and the sync
 * function are both mocked (no real Shopify HMAC verification, no real
 * Postgres — the sync function's own real behavior is covered by
 * tests/integration/billing/subscription.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const authenticateWebhook = vi.fn();
const syncSubscriptionFromWebhook = vi.fn();

vi.mock("../../../app/shopify.server", () => ({
  authenticate: { webhook: (...args: unknown[]) => authenticateWebhook(...args) },
}));
vi.mock("../../../services/billing/subscription.server", () => ({
  syncSubscriptionFromWebhook: (...args: unknown[]) => syncSubscriptionFromWebhook(...args),
}));

beforeEach(() => {
  authenticateWebhook.mockReset();
  syncSubscriptionFromWebhook.mockReset().mockResolvedValue({ wasNew: true });
});

describe("webhooks.app_subscriptions.update action", () => {
  it("syncs a well-formed payload with a derived idempotency key", async () => {
    authenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "app_subscriptions/update",
      payload: { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Starter", status: "ACTIVE", updated_at: "2026-08-22T00:00:00Z" } },
    });

    const { action } = await import("../../../app/routes/webhooks.app_subscriptions.update");
    const response = await action({ request: new Request("https://example.com/webhooks/app_subscriptions/update", { method: "POST" }) } as never);

    expect(response.status).toBe(200);
    expect(syncSubscriptionFromWebhook).toHaveBeenCalledWith(
      "test-shop.myshopify.com",
      { admin_graphql_api_id: "gid://shopify/AppSubscription/1", name: "Starter", status: "ACTIVE" },
      "app_subscriptions/update:gid://shopify/AppSubscription/1:ACTIVE:2026-08-22T00:00:00Z",
    );
  });

  it("does not call syncSubscriptionFromWebhook for a malformed payload (missing subscription id)", async () => {
    authenticateWebhook.mockResolvedValue({
      shop: "test-shop.myshopify.com",
      topic: "app_subscriptions/update",
      payload: {},
    });

    const { action } = await import("../../../app/routes/webhooks.app_subscriptions.update");
    const response = await action({ request: new Request("https://example.com/webhooks/app_subscriptions/update", { method: "POST" }) } as never);

    expect(response.status).toBe(200);
    expect(syncSubscriptionFromWebhook).not.toHaveBeenCalled();
  });

  it("produces the same idempotency key for two identical deliveries (redelivery safety)", async () => {
    const payload = {
      shop: "test-shop.myshopify.com",
      topic: "app_subscriptions/update",
      payload: { app_subscription: { admin_graphql_api_id: "gid://shopify/AppSubscription/9", name: "Pro", status: "CANCELLED", updated_at: "2026-08-22T00:00:00Z" } },
    };
    authenticateWebhook.mockResolvedValue(payload);

    const { action } = await import("../../../app/routes/webhooks.app_subscriptions.update");
    await action({ request: new Request("https://example.com/webhooks/app_subscriptions/update", { method: "POST" }) } as never);
    await action({ request: new Request("https://example.com/webhooks/app_subscriptions/update", { method: "POST" }) } as never);

    const keys = syncSubscriptionFromWebhook.mock.calls.map((call: unknown[]) => call[2]);
    expect(keys[0]).toBe(keys[1]);
  });
});
