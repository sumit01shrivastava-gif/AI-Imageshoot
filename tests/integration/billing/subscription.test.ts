/**
 * Integration tests: services/billing/subscription.server.ts +
 * db/repositories/shop-subscription.repository.ts +
 * db/repositories/billing-event.repository.ts — against real local
 * Postgres. The Shopify Billing API itself is faked (a fake
 * `AdminGraphQLClient` — never a real network call, same as every other
 * Shopify-facing test in this codebase), so this covers OUR OWN
 * persistence/idempotency logic, not Shopify's API behavior.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "../../../db/client.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { AdminGraphQLClient } from "../../../services/shopify/graphql.server";
import {
  requestPlanChange,
  cancelToFree,
  syncSubscriptionFromWebhook,
  getBillingSnapshot,
  InvalidPlanChangeError,
} from "../../../services/billing/subscription.server";
import { getPlan } from "../../../services/usage/entitlement.server";

const SHOP = "billing-subscription-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function fakeAdmin(responseBody: unknown): AdminGraphQLClient {
  return { graphql: vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } })) };
}

async function cleanup() {
  await prisma.billingEvent.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSubscription.deleteMany({ where: { shop: SHOP } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("requestPlanChange", () => {
  it("creates a PENDING ShopSubscription and a SUBSCRIPTION_REQUESTED BillingEvent", async () => {
    const admin = fakeAdmin({
      data: {
        appSubscriptionCreate: {
          appSubscription: { id: "gid://shopify/AppSubscription/100", status: "PENDING" },
          confirmationUrl: "https://admin.shopify.com/confirm/100",
          userErrors: [],
        },
      },
    });

    const result = await requestPlanChange(CONTEXT, admin, "STARTER", "https://app.example.com/billing");
    expect(result.confirmationUrl).toBe("https://admin.shopify.com/confirm/100");

    const row = await prisma.shopSubscription.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(row.planId).toBe("STARTER");
    expect(row.status).toBe("PENDING");
    expect(row.shopifySubscriptionId).toBe("gid://shopify/AppSubscription/100");

    const events = await prisma.billingEvent.findMany({ where: { shop: SHOP } });
    expect(events.some((e) => e.type === "SUBSCRIPTION_REQUESTED")).toBe(true);
  });

  it("rejects requesting the plan the shop is already actively on", async () => {
    await prisma.shopSubscription.create({ data: { shop: SHOP, planId: "PRO", status: "ACTIVE" } });
    const admin = fakeAdmin({});
    await expect(requestPlanChange(CONTEXT, admin, "PRO", "https://app.example.com/billing")).rejects.toBeInstanceOf(InvalidPlanChangeError);
  });

  it("rejects FREE as a target (use cancelToFree instead)", async () => {
    const admin = fakeAdmin({});
    await expect(requestPlanChange(CONTEXT, admin, "FREE", "https://app.example.com/billing")).rejects.toBeInstanceOf(InvalidPlanChangeError);
  });
});

describe("syncSubscriptionFromWebhook — idempotency", () => {
  it("activates the plan and records a SUBSCRIPTION_ACTIVATED event on the first delivery", async () => {
    await prisma.shopSubscription.create({
      data: { shop: SHOP, planId: "STARTER", status: "PENDING", shopifySubscriptionId: "gid://shopify/AppSubscription/200" },
    });

    const result = await syncSubscriptionFromWebhook(
      SHOP,
      { admin_graphql_api_id: "gid://shopify/AppSubscription/200", name: "Starter", status: "ACTIVE" },
      "webhook:200:active:t1",
    );
    expect(result.wasNew).toBe(true);

    const row = await prisma.shopSubscription.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(row.status).toBe("ACTIVE");
    expect(row.planId).toBe("STARTER");

    const plan = await getPlan(SHOP);
    expect(plan.id).toBe("STARTER");
  });

  it("a redelivered webhook (same idempotencyKey) is a safe no-op, not a duplicate event", async () => {
    await prisma.shopSubscription.create({
      data: { shop: SHOP, planId: "STARTER", status: "PENDING", shopifySubscriptionId: "gid://shopify/AppSubscription/201" },
    });

    const payload = { admin_graphql_api_id: "gid://shopify/AppSubscription/201", name: "Starter", status: "ACTIVE" };
    const first = await syncSubscriptionFromWebhook(SHOP, payload, "webhook:201:active:t1");
    const second = await syncSubscriptionFromWebhook(SHOP, payload, "webhook:201:active:t1");

    expect(first.wasNew).toBe(true);
    expect(second.wasNew).toBe(false);

    const events = await prisma.billingEvent.findMany({ where: { shop: SHOP, type: "WEBHOOK_RECEIVED" } });
    expect(events).toHaveLength(1);
  });

  it("a CANCELLED status webhook moves the shop's subscription status to CANCELLED", async () => {
    await prisma.shopSubscription.create({
      data: { shop: SHOP, planId: "PRO", status: "ACTIVE", shopifySubscriptionId: "gid://shopify/AppSubscription/202" },
    });

    await syncSubscriptionFromWebhook(SHOP, { admin_graphql_api_id: "gid://shopify/AppSubscription/202", name: "Pro", status: "CANCELLED" }, "webhook:202:cancelled:t1");

    const row = await prisma.shopSubscription.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(row.status).toBe("CANCELLED");

    // A CANCELLED (non-ACTIVE) subscription falls back to FREE for
    // entitlement purposes — see entitlement.server.ts's `resolvePlanId`.
    const plan = await getPlan(SHOP);
    expect(plan.id).toBe("FREE");
  });
});

describe("cancelToFree", () => {
  it("moves the shop to FREE/ACTIVE and clears the Shopify subscription id", async () => {
    await prisma.shopSubscription.create({
      data: { shop: SHOP, planId: "PRO", status: "ACTIVE", shopifySubscriptionId: "gid://shopify/AppSubscription/300" },
    });
    const admin = fakeAdmin({ data: { appSubscriptionCancel: { appSubscription: { id: "gid://shopify/AppSubscription/300", status: "CANCELLED" }, userErrors: [] } } });

    await cancelToFree(CONTEXT, admin);

    const row = await prisma.shopSubscription.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(row.planId).toBe("FREE");
    expect(row.status).toBe("ACTIVE");
    expect(row.shopifySubscriptionId).toBeNull();
  });

  it("still moves the shop to FREE locally even if Shopify's own cancel call fails", async () => {
    await prisma.shopSubscription.create({
      data: { shop: SHOP, planId: "PRO", status: "ACTIVE", shopifySubscriptionId: "gid://shopify/AppSubscription/301" },
    });
    const admin: AdminGraphQLClient = { graphql: vi.fn(async () => new Response("boom", { status: 500 })) };

    await cancelToFree(CONTEXT, admin);

    const row = await prisma.shopSubscription.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(row.planId).toBe("FREE");
  });

  it("is a safe no-op (no Shopify call) for a shop already on FREE", async () => {
    const admin: AdminGraphQLClient = { graphql: vi.fn() };
    await cancelToFree(CONTEXT, admin);
    expect(admin.graphql).not.toHaveBeenCalled();
    const row = await prisma.shopSubscription.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(row.planId).toBe("FREE");
  });
});

describe("getBillingSnapshot", () => {
  it("reflects the shop's real current plan and status", async () => {
    await prisma.shopSubscription.create({ data: { shop: SHOP, planId: "BUSINESS", status: "ACTIVE" } });
    const snapshot = await getBillingSnapshot(CONTEXT);
    expect(snapshot.currentPlan.id).toBe("BUSINESS");
    expect(snapshot.status).toBe("ACTIVE");
    expect(snapshot.allPlans).toHaveLength(4);
  });

  it("reports NONE status and the FREE plan for a shop with no subscription row", async () => {
    const snapshot = await getBillingSnapshot(CONTEXT);
    expect(snapshot.currentPlan.id).toBe("FREE");
    expect(snapshot.status).toBe("NONE");
  });
});
