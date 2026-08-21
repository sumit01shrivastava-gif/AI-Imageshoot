/**
 * Integration test for app/routes/app.usage.tsx's loader — the route
 * layer over services/usage/usage-accounting.server.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import { recordUsageEvent } from "../../../db/repositories/usage-event.repository";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

const SHOP = "route-usage-test.myshopify.com";
const OTHER_SHOP = "route-usage-test-other.myshopify.com";

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/usage", { headers: { "x-ai-imageshoot-e2e-shop": shop } });
}

async function cleanup() {
  await prisma.usageEvent.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
}

let loader: typeof import("../../../app/routes/app.usage").loader;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  resetEnvCacheForTests();
  ({ loader } = await import("../../../app/routes/app.usage"));
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function callLoader(shop: string) {
  return loader({ request: requestFor(shop), params: {}, context: {} } as unknown as Parameters<typeof loader>[0]);
}

describe("app.usage — loader", () => {
  it("returns an empty summary/recent-events list for a shop with no usage yet", async () => {
    const result = await callLoader(SHOP);
    expect(result.overview.recentEvents.events).toHaveLength(0);
    expect(result.overview.summary).toHaveLength(0);
  });

  it("returns this shop's usage only, never another shop's", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "g1", outputCount: 2 });
    await recordUsageEvent({ shop: OTHER_SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "g-other" });

    const result = await callLoader(SHOP);
    expect(result.overview.recentEvents.events).toHaveLength(1);
    expect(result.overview.recentEvents.events[0].jobId).toBe("g1");
    expect(result.overview.summary.find((s) => s.operationType === "IMAGE_GENERATION")?.succeededCount).toBe(1);
  });
});
