/**
 * Integration tests: db/repositories/usage-event.repository.ts +
 * services/usage/usage-accounting.server.ts — the usage ledger's
 * idempotency semantics, listing, and summary aggregation. Against real
 * local Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import {
  recordUsageEvent,
  listUsageEventsForShop,
  getUsageSummaryForShop,
} from "../../../db/repositories/usage-event.repository";
import { getUsageOverview } from "../../../services/usage/usage-accounting.server";
import type { AuthContext } from "../../../lib/auth/types";

const SHOP = "usage-ledger-test.myshopify.com";
const OTHER_SHOP = "usage-ledger-test-other.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

async function cleanup() {
  await prisma.usageEvent.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("recordUsageEvent — idempotency", () => {
  it("records exactly one event when called twice for the same operationType+jobId (a duplicate delivery)", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "job-1", outputCount: 1 });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "job-1", outputCount: 1 });

    const page = await listUsageEventsForShop(SHOP, {}, 1);
    expect(page.total).toBe(1);
  });

  it("a retry that fails then succeeds for the SAME jobId ends up recorded once, with the latest (SUCCEEDED) status", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_PROCESSING", status: "FAILED", jobId: "job-2", durationMs: 10 });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_PROCESSING", status: "SUCCEEDED", jobId: "job-2", durationMs: 15 });

    const page = await listUsageEventsForShop(SHOP, {}, 1);
    expect(page.total).toBe(1);
    expect(page.events[0].status).toBe("SUCCEEDED");
    expect(page.events[0].durationMs).toBe(15);
  });

  it("a Regenerate (a NEW jobId) is recorded as a separate, additional event — not collapsed", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "job-original", outputCount: 1 });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "job-regenerated", outputCount: 1 });

    const page = await listUsageEventsForShop(SHOP, {}, 1);
    expect(page.total).toBe(2);
  });

  it("the same jobId under a DIFFERENT operationType is a distinct event (idempotency key includes operationType)", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "shared-id" });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_PROCESSING", status: "SUCCEEDED", jobId: "shared-id" });

    const page = await listUsageEventsForShop(SHOP, {}, 1);
    expect(page.total).toBe(2);
  });
});

describe("listUsageEventsForShop", () => {
  it("is most-recent-first, paginated, and never returns another shop's events", async () => {
    for (let i = 0; i < 3; i += 1) {
      await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: `job-${i}` });
    }
    await recordUsageEvent({ shop: OTHER_SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "other-job" });

    const page = await listUsageEventsForShop(SHOP, {}, 1, 2);
    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.events[0].jobId).toBe("job-2");
  });

  it("filters by operationType and status", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "gen-1" });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_PROCESSING", status: "FAILED", jobId: "proc-1" });

    const genOnly = await listUsageEventsForShop(SHOP, { operationType: "IMAGE_GENERATION" }, 1);
    expect(genOnly.events.every((e) => e.operationType === "IMAGE_GENERATION")).toBe(true);

    const failedOnly = await listUsageEventsForShop(SHOP, { status: "FAILED" }, 1);
    expect(failedOnly.events).toHaveLength(1);
    expect(failedOnly.events[0].jobId).toBe("proc-1");
  });
});

describe("getUsageSummaryForShop", () => {
  it("aggregates succeeded/failed counts and total output count per operation type", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "g1", outputCount: 2 });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "g2", outputCount: 3 });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "FAILED", jobId: "g3" });
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_PROCESSING", status: "SUCCEEDED", jobId: "p1", outputCount: 1 });

    const summary = await getUsageSummaryForShop(SHOP, new Date(0));
    const generation = summary.find((s) => s.operationType === "IMAGE_GENERATION");
    expect(generation).toMatchObject({ succeededCount: 2, failedCount: 1, totalOutputCount: 5 });

    const processing = summary.find((s) => s.operationType === "IMAGE_PROCESSING");
    expect(processing).toMatchObject({ succeededCount: 1, failedCount: 0, totalOutputCount: 1 });
  });

  it("excludes events before the given window", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "IMAGE_GENERATION", status: "SUCCEEDED", jobId: "old-job" });

    const future = new Date(Date.now() + 60_000);
    const summary = await getUsageSummaryForShop(SHOP, future);
    expect(summary).toHaveLength(0);
  });
});

describe("getUsageOverview", () => {
  it("returns a current-period summary and recent events, scoped to the requesting shop", async () => {
    await recordUsageEvent({ shop: SHOP, operationType: "STORE_VISUAL_GENERATION", status: "SUCCEEDED", jobId: "sv1", outputCount: 1 });
    await recordUsageEvent({ shop: OTHER_SHOP, operationType: "STORE_VISUAL_GENERATION", status: "SUCCEEDED", jobId: "sv-other" });

    const overview = await getUsageOverview(CONTEXT);
    expect(overview.recentEvents.events.some((e) => e.jobId === "sv1")).toBe(true);
    expect(overview.recentEvents.events.some((e) => e.jobId === "sv-other")).toBe(false);
    expect(overview.summary.some((s) => s.operationType === "STORE_VISUAL_GENERATION")).toBe(true);
  });
});
