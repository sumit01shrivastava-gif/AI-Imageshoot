/**
 * E2E: Product Intelligence (Phase 2).
 *
 * Shopify product → product detail → Analyze Product → processing state →
 * completed intelligence → intelligence displayed.
 *
 * Authenticates via the same E2E test seam as tests/e2e/products.spec.ts.
 * The web app under test runs in a separate process (Playwright's
 * webServer — see playwright.config.ts), so "Analyze Product" only
 * *enqueues* a real BullMQ job there; this file runs an actual
 * `product-intelligence` worker *in the test process* (both processes
 * share the same Redis/Postgres, so this works exactly like a real worker
 * process would) rather than mocking the analysis away — see the Phase 2
 * instructions ("Do NOT mock away the entire intelligence workflow") and
 * tests/integration/queue/catalog-sync-queue.test.ts, which established
 * this same "construct a real Worker inside the test" pattern.
 *
 * `AI_PROVIDER=deterministic-test` only needs to be set here (the test
 * process running the worker) — the web server process never resolves an
 * AIProvider itself; only the worker does, when it actually processes a
 * job. See services/intelligence/provider.server.ts.
 */
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "deterministic-test";

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetEnvCacheForTests } from "../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../lib/queue";
import { processProductIntelligenceJob } from "../../services/intelligence/job.server";
import type { ProductIntelligenceJobPayload } from "../../services/intelligence/job.server";

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6380";
resetEnvCacheForTests();

const prisma = new PrismaClient();

const TEST_SHOP = "e2e-intelligence-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };
const PRODUCT_ID = "gid://shopify/Product/9100000000001";

const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let worker: ReturnType<typeof createWorker<ProductIntelligenceJobPayload>> | undefined;

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: TEST_SHOP } });
}

async function seedProduct() {
  await cleanup();
  return prisma.shopifyProduct.create({
    data: {
      shop: TEST_SHOP,
      shopifyProductId: PRODUCT_ID,
      title: "Modern Lounge Chair",
      handle: "modern-lounge-chair",
      description: "A minimalist lounge chair.",
      productType: "Furniture",
      vendor: "Acme Home",
      tags: ["chair", "living-room"],
      status: "ACTIVE",
      shopifyCreatedAt: new Date("2026-01-01T00:00:00Z"),
      shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      media: {
        create: [
          {
            shop: TEST_SHOP,
            shopifyProductId: PRODUCT_ID,
            shopifyMediaId: "gid://shopify/MediaImage/9100000000001",
            mediaType: "IMAGE",
            originalUrl: PLACEHOLDER_IMAGE,
            previewUrl: PLACEHOLDER_IMAGE,
            altText: "Lounge chair",
            position: 0,
          },
        ],
      },
    },
  });
}

test.beforeAll(async () => {
  worker = createWorker<ProductIntelligenceJobPayload>("product-intelligence", processProductIntelligenceJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));
});

test.afterAll(async () => {
  await cleanup();
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
});

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(HEADER);
  await page.addInitScript(() => {
    Object.assign(window, { shopify: { toast: { show: () => {} } } });
  });
});

test.describe("Product Intelligence", () => {
  test("Analyze Product moves from not-analyzed to a completed, displayed profile", async ({ page }) => {
    const product = await seedProduct();

    // Shopify product → product detail.
    await page.goto(`/app/products/${product.id}`);
    await expect(page.getByText("Product Intelligence")).toBeVisible();
    await expect(page.getByText("Not analyzed", { exact: true })).toBeVisible();

    // → Analyze Product.
    const analyzeButton = page.getByRole("button", { name: "Analyze Product" });
    await expect(analyzeButton).toBeVisible();
    await analyzeButton.click();

    // → processing state / → completed intelligence (the in-test worker
    // races the UI's 3s auto-poll — whichever the merchant would actually
    // see, the end state is what matters here).
    await expect(page.getByText("Ready", { exact: true })).toBeVisible({ timeout: 15_000 });

    // → intelligence displayed: category + model suitability +
    // recommended asset types for a Furniture product (per
    // services/intelligence/category-recommendations.ts: not model
    // suitable, scene-oriented recommendations) — proves this is the real
    // recommendation engine's output, not a placeholder.
    //
    // "Furniture" legitimately appears more than once on the page (the
    // Intelligence category *and* subcategory both resolve to the
    // product's Shopify product type, plus the raw Shopify product-type
    // field further down) — so scope to the "Category" field's value
    // specifically rather than asserting on the bare text.
    const categoryValue = page
      .getByText("Category", { exact: true })
      .locator("xpath=following-sibling::s-text[1]");
    await expect(categoryValue).toHaveText("Furniture");
    await expect(page.getByText("No", { exact: true })).toBeVisible(); // Model suitable: No
    await expect(page.getByText(/product_studio/)).toBeVisible();

    // Re-analyze is now offered instead of the initial "Analyze Product".
    await expect(page.getByRole("button", { name: "Re-analyze Product" })).toBeVisible();
  });
});
