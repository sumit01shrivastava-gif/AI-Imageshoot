/**
 * Integration test for app/routes/app.billing.tsx's loader and action —
 * route → service wiring, against real Postgres. Authenticates via the
 * E2E test seam (see tests/integration/routes/app.products.id-loader.test.ts
 * for why). The E2E seam's fake `admin` client always errors on
 * `.graphql()` (no real Shopify API access in tests — see
 * admin-context.server.ts), so this covers the loader and the
 * cancel-to-FREE action (which tolerates a failing Shopify call — see
 * subscription.server.ts's `cancelToFree`) plus the change-plan action's
 * safe FAILURE path; the real Shopify-success path is covered by
 * tests/integration/billing/subscription.test.ts and
 * tests/unit/billing/shopify-billing-provider.test.ts with a faked
 * `AdminGraphQLClient`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

const SHOP = "route-billing-test.myshopify.com";

function e2eRequest(body?: Record<string, string>) {
  const headers = { "x-ai-imageshoot-e2e-shop": SHOP };
  if (!body) {
    return new Request("https://example.com/app/billing", { headers });
  }
  const formData = new URLSearchParams(body);
  return new Request("https://example.com/app/billing", { method: "POST", headers, body: formData });
}

async function cleanup() {
  await prisma.billingEvent.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSubscription.deleteMany({ where: { shop: SHOP } });
}

let loader: typeof import("../../../app/routes/app.billing").loader;
let action: typeof import("../../../app/routes/app.billing").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  resetEnvCacheForTests();
  ({ loader, action } = await import("../../../app/routes/app.billing"));
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
  delete process.env.ALLOW_E2E_AUTH_BYPASS;
});

describe("app.billing loader", () => {
  it("reports the FREE plan and NONE status for a shop with no subscription", async () => {
    const result = await loader({ request: e2eRequest(), params: {}, context: {} } as never);
    expect(result.snapshot.currentPlan.id).toBe("FREE");
    expect(result.snapshot.status).toBe("NONE");
    expect(result.remainingCredits).toBe(result.snapshot.currentPlan.monthlyCredits);
  });

  it("reflects a real ShopSubscription row", async () => {
    await prisma.shopSubscription.create({ data: { shop: SHOP, planId: "PRO", status: "ACTIVE" } });
    const result = await loader({ request: e2eRequest(), params: {}, context: {} } as never);
    expect(result.snapshot.currentPlan.id).toBe("PRO");
    expect(result.snapshot.status).toBe("ACTIVE");
  });
});

describe("app.billing action", () => {
  it("cancel moves the shop to FREE even though the E2E admin stub can't reach Shopify", async () => {
    await prisma.shopSubscription.create({
      data: { shop: SHOP, planId: "STARTER", status: "ACTIVE", shopifySubscriptionId: "gid://shopify/AppSubscription/1" },
    });

    const result = await action({ request: e2eRequest({ intent: "cancel" }), params: {}, context: {} } as never);
    expect(result).toEqual({ ok: true, confirmationUrl: null });

    const row = await prisma.shopSubscription.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(row.planId).toBe("FREE");
  });

  it("change-plan surfaces a safe, merchant-facing error when Shopify billing can't be reached", async () => {
    const result = await action({ request: e2eRequest({ intent: "change-plan", planId: "PRO" }), params: {}, context: {} } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toMatch(/stack|GraphQL|internal/i);
    }
  });

  it("rejects an unknown intent", async () => {
    const result = await action({ request: e2eRequest({ intent: "nonsense" }), params: {}, context: {} } as never);
    expect(result).toEqual({ ok: false, error: "Unknown action." });
  });

  it("rejects a client-supplied planId that isn't a real plan (never crashes)", async () => {
    const result = await action({ request: e2eRequest({ intent: "change-plan", planId: "SUPER_ULTRA_PLAN" }), params: {}, context: {} } as never);
    expect(result).toEqual({ ok: false, error: "Unknown plan." });
  });
});
