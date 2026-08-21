/**
 * Integration test: db/repositories/store-visual-job.repository.ts — the
 * paginated, filterable shop-wide listing (`listStoreVisualJobsForShop`)
 * and tenant isolation. Against a real local Postgres.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import prisma from "../../../db/client.server";
import {
  createStoreVisualJob,
  getStoreVisualJob,
  listStoreVisualJobsForShop,
  markSucceeded,
} from "../../../db/repositories/store-visual-job.repository";
import { parseStoreVisualPlan } from "../../../services/store-visuals/schema";
import { TenantMismatchError } from "../../../lib/auth/tenant.server";
import type { AuthContext } from "../../../lib/auth/types";

const SHOP_A = "store-visual-repo-test-a.myshopify.com";
const SHOP_B = "store-visual-repo-test-b.myshopify.com";
const CONTEXT_A: AuthContext = { shop: SHOP_A, sessionId: "s1", isOnline: false };

function plan(visualType: "HOMEPAGE_HERO" | "STORE_CTA" = "HOMEPAGE_HERO") {
  return parseStoreVisualPlan({
    visualType,
    products: [],
    creativeDirection: { prompt: "Test prompt.", negativeConstraints: [] },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    brandStyle: null,
    constraints: [],
  });
}

async function cleanup() {
  await prisma.storeVisualJob.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

beforeAll(cleanup);
afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("createStoreVisualJob / getStoreVisualJob", () => {
  it("creates a new PENDING row every time — never upserts", async () => {
    const first = await createStoreVisualJob({ shop: SHOP_A, type: "HOMEPAGE_HERO", plan: plan(), productIds: [] });
    const second = await createStoreVisualJob({ shop: SHOP_A, type: "HOMEPAGE_HERO", plan: plan(), productIds: [] });
    expect(first.id).not.toBe(second.id);
  });

  it("throws TenantMismatchError for another shop's job", async () => {
    const jobB = await createStoreVisualJob({ shop: SHOP_B, type: "STORE_CTA", plan: plan("STORE_CTA"), productIds: [] });
    await expect(getStoreVisualJob(CONTEXT_A, jobB.id)).rejects.toThrow(TenantMismatchError);
  });

  it("returns null for a job id that doesn't exist", async () => {
    expect(await getStoreVisualJob(CONTEXT_A, "does-not-exist")).toBeNull();
  });
});

describe("listStoreVisualJobsForShop", () => {
  it("is shop-wide (not per-product), most-recent-first, and paginated", async () => {
    // Created sequentially (not Promise.all) — concurrent creation gives no
    // guarantee that DB insertion/createdAt order matches array-index
    // order, which would make the "most recent first" assertion below flaky.
    const jobs = [];
    for (let i = 0; i < 5; i += 1) {
      jobs.push(await createStoreVisualJob({ shop: SHOP_A, type: "HOMEPAGE_HERO", plan: plan(), productIds: [] }));
    }

    const page1 = await listStoreVisualJobsForShop(CONTEXT_A, {}, 1, 3);
    expect(page1.jobs).toHaveLength(3);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    // Most recent first — the last-created job leads.
    expect(page1.jobs[0].id).toBe(jobs[4].id);

    const page2 = await listStoreVisualJobsForShop(CONTEXT_A, {}, 2, 3);
    expect(page2.jobs).toHaveLength(2);
    expect(page2.total).toBe(5);
  });

  it("filters by type and status", async () => {
    const hero = await createStoreVisualJob({ shop: SHOP_A, type: "HOMEPAGE_HERO", plan: plan(), productIds: [] });
    await createStoreVisualJob({ shop: SHOP_A, type: "STORE_CTA", plan: plan("STORE_CTA"), productIds: [] });
    await markSucceeded(SHOP_A, hero.id, { providerName: "deterministic-test", providerJobId: undefined, durationMs: 10 });

    const heroOnly = await listStoreVisualJobsForShop(CONTEXT_A, { type: "HOMEPAGE_HERO" }, 1);
    expect(heroOnly.jobs.every((j) => j.type === "HOMEPAGE_HERO")).toBe(true);

    const succeededOnly = await listStoreVisualJobsForShop(CONTEXT_A, { status: "SUCCEEDED" }, 1);
    expect(succeededOnly.jobs).toHaveLength(1);
    expect(succeededOnly.jobs[0].id).toBe(hero.id);
  });

  it("never returns another shop's jobs", async () => {
    await createStoreVisualJob({ shop: SHOP_B, type: "HOMEPAGE_HERO", plan: plan(), productIds: [] });
    const result = await listStoreVisualJobsForShop(CONTEXT_A, {}, 1);
    expect(result.jobs).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("clamps an invalid page number to 1 rather than erroring", async () => {
    await createStoreVisualJob({ shop: SHOP_A, type: "HOMEPAGE_HERO", plan: plan(), productIds: [] });
    const result = await listStoreVisualJobsForShop(CONTEXT_A, {}, -5);
    expect(result.page).toBe(1);
    expect(result.jobs.length).toBeGreaterThan(0);
  });
});
