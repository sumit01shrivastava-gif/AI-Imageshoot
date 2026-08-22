/**
 * Integration test: services/store-visuals/request-store-visual.server.ts's
 * `requestStoreVisual` rollback boundary — same gap/fix as
 * tests/integration/generation/request-generation-rollback.test.ts,
 * applied to the store-visuals domain. `services/store-visuals/queue.server.ts`
 * is mocked (its `enqueueStoreVisualJob` throws); everything else is real
 * Postgres. Uses a zero-product visual (HOMEPAGE_HERO) since store visuals
 * don't require a featured product — see build-plan.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import prisma from "../../../db/client.server";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import type { AuthContext } from "../../../lib/auth/types";

vi.mock("../../../services/store-visuals/queue.server", () => ({
  enqueueStoreVisualJob: vi.fn(async () => {
    throw new Error("simulated Redis failure");
  }),
}));

const SHOP = "store-visual-rollback-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

async function cleanup() {
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
  await prisma.storeVisualJob.deleteMany({ where: { shop: SHOP } });
}

let requestStoreVisual: typeof import("../../../services/store-visuals/request-store-visual.server").requestStoreVisual;

beforeAll(async () => {
  resetEnvCacheForTests();
  ({ requestStoreVisual } = await import("../../../services/store-visuals/request-store-visual.server"));
  await cleanup();

  // STORE_VISUAL_GENERATION is plan-gated (FREE doesn't include it) — see
  // services/billing/plans.ts. Seeded once, removed in afterAll.
  await prisma.shopSubscription.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, planId: "STARTER", status: "ACTIVE" },
    update: { planId: "STARTER", status: "ACTIVE" },
  });
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.shopSubscription.deleteMany({ where: { shop: SHOP } });
  await prisma.$disconnect();
});

describe("requestStoreVisual — rollback on enqueue failure", () => {
  it(
    "refunds the credit reservation and marks the job FAILED when enqueueing fails after reservation",
    async () => {
      await expect(requestStoreVisual(CONTEXT, { visualType: "HOMEPAGE_HERO" })).rejects.toThrow(
        "simulated Redis failure",
      );

      const jobRow = await prisma.storeVisualJob.findFirstOrThrow({ where: { shop: SHOP } });
      expect(jobRow.status).toBe("FAILED");

      const reservation = await prisma.creditReservation.findUniqueOrThrow({ where: { jobId: jobRow.id } });
      expect(reservation.status).toBe("REFUNDED");
    },
    15000,
  );
});
