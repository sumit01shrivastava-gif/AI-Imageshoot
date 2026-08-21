/**
 * Integration test for app/routes/app.products.$id.tsx's Phase 5/6
 * additions: `availableBrandStylePresets` loader data, and the
 * "generate-product-imagery" / "review-generation-result" /
 * "regenerate-product-imagery" actions (LIFESTYLE case here — see
 * app.products.id-model-shoot-action.test.ts for the MODEL_SHOOT case).
 * Mirrors app.products.id-generation-action.test.ts's pattern — see that
 * file's doc comment for the E2E auth-bypass seam reasoning.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import type { SyncedProduct } from "../../../services/products/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP_A = "route-lifestyle-gen-a.myshopify.com";
const SHOP_B = "route-lifestyle-gen-b.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Leather Tote",
    handle: "leather-tote",
    description: "",
    productType: "Handbags",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [
      {
        shopifyMediaId: `${id}-media-1`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/tote.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Leather tote",
        position: 0,
      },
    ],
  };
}

async function seedAnalyzed(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });
  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["lifestyle"],
    identityAnchors: { category: "Handbags", material: "Leather" },
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });
  return row;
}

function requestFor(shop: string): Request {
  return new Request("https://example.com/app/products/x", {
    headers: { "x-ai-imageshoot-e2e-shop": shop },
  });
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: { in: [SHOP_A, SHOP_B] } } });
}

let worker: Worker | undefined;
let loader: typeof import("../../../app/routes/app.products.$id").loader;
let action: typeof import("../../../app/routes/app.products.$id").action;

beforeAll(async () => {
  process.env.ALLOW_E2E_AUTH_BYPASS = "1";
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ loader, action } = await import("../../../app/routes/app.products.$id"));
  const { processGenerationJob } = await import("../../../services/generation/job.server");
  worker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();
});
afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});
afterAll(async () => {
  await cleanup();
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

async function callLoader(shop: string, id: string) {
  return loader({
    request: requestFor(shop),
    params: { id },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

async function callAction(shop: string, id: string, body: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const request = new Request("https://example.com/app/products/x", {
    method: "POST",
    headers: { "x-ai-imageshoot-e2e-shop": shop },
    body: formData,
  });
  return action({ request, params: { id }, context: {} } as unknown as Parameters<typeof action>[0]);
}

function waitForLifestyleStatus(shop: string, id: string, status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callLoader(shop, id);
      const latest = result.generationHistory.find((job) => job.type === "LIFESTYLE");
      if (latest?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${latest?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.products.$id — availableBrandStylePresets loader data", () => {
  it("includes all 6 built-in presets", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");
    const result = await callLoader(SHOP_A, row.id);
    expect(result.availableBrandStylePresets).toHaveLength(6);
    expect(result.availableBrandStylePresets.map((p) => p.name)).toContain("Minimal Studio");
  });
});

describe("app.products.$id — 'generate-product-imagery' action (LIFESTYLE)", () => {
  it(
    "queues a LIFESTYLE generation with a chosen preset, and the loader eventually reflects the completed result",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");

      const actionResult = await callAction(SHOP_A, row.id, {
        intent: "generate-product-imagery",
        generationType: "LIFESTYLE",
        presetId: "luxury-editorial",
      });
      expect(actionResult).toEqual({ ok: true });

      await waitForLifestyleStatus(SHOP_A, row.id, "SUCCEEDED");

      const result = await callLoader(SHOP_A, row.id);
      const lifestyle = result.generationHistory.filter((job) => job.type === "LIFESTYLE");
      expect(lifestyle).toHaveLength(1);
      expect(lifestyle[0].status).toBe("SUCCEEDED");
      expect(lifestyle[0].results[0].reviewStatus).toBe("PENDING");

      // PRODUCT_CLEANUP's own history stays untouched/empty — the two
      // generationTypes are independent (see productCleanupHistory's
      // filter in the route component).
      const cleanup = result.generationHistory.filter((job) => job.type === "PRODUCT_CLEANUP");
      expect(cleanup).toHaveLength(0);
    },
    15000,
  );

  it("an unknown presetId is not an error — falls back to category defaults", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");
    const actionResult = await callAction(SHOP_A, row.id, {
      intent: "generate-product-imagery",
      generationType: "LIFESTYLE",
      presetId: "nope",
    });
    expect(actionResult).toEqual({ ok: true });
  });

  it("returns a merchant-safe error when the product hasn't been analyzed yet", async () => {
    await upsertSyncedProduct(SHOP_A, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_A } });

    const result = await callAction(SHOP_A, row.id, { intent: "generate-product-imagery", generationType: "LIFESTYLE" });
    expect(result).toEqual({
      ok: false,
      error: "This product must be analyzed (Product Intelligence) before generating images.",
    });
  });

  it("throws a safe 404 for a product belonging to another shop", async () => {
    const otherRow = await seedAnalyzed(SHOP_B, "gid://shopify/Product/1");

    let caught: unknown;
    try {
      await callAction(SHOP_A, otherRow.id, { intent: "generate-product-imagery", generationType: "LIFESTYLE" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });
});

describe("app.products.$id — 'review-generation-result' and 'regenerate-product-imagery' actions", () => {
  it(
    "approves a result, and regenerating creates a new job while preserving the approved one",
    async () => {
      const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");
      await callAction(SHOP_A, row.id, { intent: "generate-product-imagery", generationType: "LIFESTYLE" });
      await waitForLifestyleStatus(SHOP_A, row.id, "SUCCEEDED");

      const first = await callLoader(SHOP_A, row.id);
      const firstJob = first.generationHistory.find((job) => job.type === "LIFESTYLE")!;
      const resultId = firstJob.results[0].id;

      const reviewResult = await callAction(SHOP_A, row.id, {
        intent: "review-generation-result",
        resultId,
        decision: "APPROVED",
      });
      expect(reviewResult).toEqual({ ok: true });

      const regenerateResult = await callAction(SHOP_A, row.id, {
        intent: "regenerate-product-imagery",
        jobId: firstJob.id,
        presetId: "",
      });
      expect(regenerateResult).toEqual({ ok: true });

      await waitForLifestyleStatus(SHOP_A, row.id, "SUCCEEDED");
      const second = await callLoader(SHOP_A, row.id);
      const lifestyleJobs = second.generationHistory.filter((job) => job.type === "LIFESTYLE");
      expect(lifestyleJobs).toHaveLength(2);
      // The original, approved result is untouched by the new request.
      const stillApproved = lifestyleJobs.find((job) => job.id === firstJob.id);
      expect(stillApproved?.results[0].reviewStatus).toBe("APPROVED");
    },
    20000,
  );

  it("review-generation-result throws a safe 404 for an unknown resultId", async () => {
    const row = await seedAnalyzed(SHOP_A, "gid://shopify/Product/1");
    let caught: unknown;
    try {
      await callAction(SHOP_A, row.id, {
        intent: "review-generation-result",
        resultId: "does-not-exist",
        decision: "APPROVED",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
  });
});
