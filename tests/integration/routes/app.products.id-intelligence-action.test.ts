/**
 * Integration test for app/routes/app.products.$id.tsx's Product
 * Intelligence loader data + "analyze" action — the route layer of the
 * route → service → provider → validation → persistence → UI chain (see
 * tests/integration/intelligence/product-intelligence-queue.test.ts for
 * the service/provider/persistence layers, and tests/e2e/ for the full
 * browser-driven path).
 *
 * Authenticates via the E2E test seam — see
 * tests/integration/routes/app.products.id-loader.test.ts for why
 * `ALLOW_E2E_AUTH_BYPASS`/`AI_PROVIDER` are set in `beforeAll`, not at
 * module load (ES module import hoisting).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import type { SyncedProduct } from "../../../services/products/types";
import type { ProductIntelligenceJobPayload } from "../../../services/intelligence/job.server";

const SHOP_A = "route-intel-a.myshopify.com";
const SHOP_B = "route-intel-b.myshopify.com";

function product(id: string): SyncedProduct {
  return {
    shopifyProductId: id,
    title: "Studio Sofa",
    handle: "studio-sofa",
    description: "",
    productType: "Furniture",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [],
  };
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
  const { processProductIntelligenceJob } = await import("../../../services/intelligence/job.server");
  worker = createWorker<ProductIntelligenceJobPayload>("product-intelligence", processProductIntelligenceJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();
});
afterEach(cleanup);
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

function waitForReady(shop: string, id: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const result = await callLoader(shop, id);
      if (result.intelligenceState === "ready") {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last state ${result.intelligenceState}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("app.products.$id — Product Intelligence loader data", () => {
  it("is 'not_analyzed' for a product with no intelligence profile yet", async () => {
    await upsertSyncedProduct(SHOP_A, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_A } });

    const result = await callLoader(SHOP_A, row.id);
    expect(result.intelligenceState).toBe("not_analyzed");
    expect(result.intelligence).toBeNull();
  });
});

describe("app.products.$id — 'analyze' action", () => {
  it("queues analysis, and the loader eventually reflects the completed result", async () => {
    await upsertSyncedProduct(SHOP_A, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_A } });

    const actionResult = await callAction(SHOP_A, row.id, { intent: "analyze" });
    expect(actionResult).toEqual({ ok: true });

    await waitForReady(SHOP_A, row.id);

    const result = await callLoader(SHOP_A, row.id);
    expect(result.intelligenceState).toBe("ready");
    expect(result.intelligence?.category).toBeTruthy();
    expect(result.intelligence?.recommendedAssetTypes.length).toBeGreaterThan(0);
  });

  it("throws a safe 404 — not a raw TenantMismatchError — for a product belonging to another shop", async () => {
    await upsertSyncedProduct(SHOP_B, product("gid://shopify/Product/1"));
    const otherRow = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_B } });

    let caught: unknown;
    try {
      await callAction(SHOP_A, otherRow.id, { intent: "analyze" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(404);
    expect(await (caught as Response).text()).toBe("Product not found");
  });

  it("returns a generic, safe error for an unknown intent", async () => {
    await upsertSyncedProduct(SHOP_A, product("gid://shopify/Product/1"));
    const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP_A } });

    const result = await callAction(SHOP_A, row.id, { intent: "bogus" });
    expect(result).toEqual({ ok: false, error: "Unknown action." });
  });
});
