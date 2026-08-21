/**
 * E2E: Store Visuals (Phase 7 completion pass — see docs/store-visuals.md)
 * and the AI Assets library (services/assets/asset-library.server.ts).
 *
 * Store-level flow: Store Visuals → create a homepage hero with no
 * specific product featured → queued/processing → succeeded → result
 * visible → Approve → Regenerate → verify the previous (approved) result
 * remains, independently of the new job.
 *
 * Asset Library flow: seed a product-scoped generation result directly
 * (mirrors tests/e2e/lifestyle-generation.spec.ts's seeding pattern) plus
 * a store visual created through the UI, then verify AI Assets lists
 * both, newest first, and that the Source filter narrows correctly.
 *
 * Same pattern as the other E2E specs: the web app runs in a separate
 * process (playwright.config.ts's `webServer`); this file runs real
 * `"store-visuals"` and `"generation"` workers *in the test process*
 * (shared Redis/Postgres) rather than mocking generation away.
 */
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "deterministic-test";

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetEnvCacheForTests } from "../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../lib/queue";
import { processStoreVisualJob } from "../../services/store-visuals/job.server";
import type { StoreVisualJobPayload } from "../../services/store-visuals/job.server";
import { processGenerationJob } from "../../services/generation/job.server";
import type { GenerationJobPayload } from "../../services/generation/job.server";

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6380";
resetEnvCacheForTests();

const prisma = new PrismaClient();

const TEST_SHOP = "e2e-store-visuals-shop.myshopify.com";
const OTHER_SHOP = "e2e-store-visuals-other-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };
const OTHER_HEADER = { "x-ai-imageshoot-e2e-shop": OTHER_SHOP };

const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let storeVisualWorker: ReturnType<typeof createWorker<StoreVisualJobPayload>> | undefined;
let generationWorker: ReturnType<typeof createWorker<GenerationJobPayload>> | undefined;

async function cleanup() {
  for (const shop of [TEST_SHOP, OTHER_SHOP]) {
    await prisma.storeVisualJob.deleteMany({ where: { shop } });
    await prisma.generationJob.deleteMany({ where: { shop } });
    await prisma.shopifyProduct.deleteMany({ where: { shop } });
  }
}

async function seedAnalyzedProduct(shop: string, shopifyProductId: string, title: string) {
  const product = await prisma.shopifyProduct.create({
    data: {
      shop,
      shopifyProductId,
      title,
      handle: title.toLowerCase().replace(/\s+/g, "-"),
      description: "A handcrafted leather handbag.",
      productType: "Handbags",
      vendor: "Acme",
      tags: ["leather"],
      status: "ACTIVE",
      shopifyCreatedAt: new Date("2026-01-01T00:00:00Z"),
      shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      media: {
        create: [
          {
            shop,
            shopifyProductId,
            shopifyMediaId: `${shopifyProductId}-media`,
            mediaType: "IMAGE",
            originalUrl: PLACEHOLDER_IMAGE,
            previewUrl: PLACEHOLDER_IMAGE,
            altText: `${title} front`,
            position: 0,
          },
        ],
      },
    },
  });

  await prisma.productIntelligence.create({
    data: {
      shop,
      productId: product.id,
      status: "READY",
      category: "Handbags",
      material: "Leather",
      primaryColor: "Brown",
      modelSuitable: false,
      recommendedAssetTypes: ["product_studio", "lifestyle"],
      recommendedEnvironments: ["studio"],
      recommendedPoseTypes: [],
      identityAnchors: {
        category: "Handbags",
        shape: "Rectangular",
        material: "Leather",
        primaryColor: "Brown",
        constructionDetails: ["structured body"],
        distinctiveHardware: ["gold clasp"],
        brandingVisible: false,
        brandingDescription: null,
      },
      analysisVersion: 1,
      providerName: "deterministic-test",
      sourceShopifyUpdatedAt: product.shopifyUpdatedAt,
    },
  });

  return product;
}

test.beforeAll(async () => {
  storeVisualWorker = createWorker<StoreVisualJobPayload>("store-visuals", processStoreVisualJob);
  generationWorker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
  await Promise.all([
    new Promise<void>((resolve) => storeVisualWorker!.on("ready", () => resolve())),
    new Promise<void>((resolve) => generationWorker!.on("ready", () => resolve())),
  ]);

  // STORE_VISUAL_GENERATION is plan-gated (FREE doesn't include it —
  // see services/billing/plans.ts); this spec exercises store visuals
  // directly, not billing, so both shops need a plan that does.
  for (const shop of [TEST_SHOP, OTHER_SHOP]) {
    await prisma.shopSubscription.upsert({
      where: { shop },
      create: { shop, planId: "STARTER", status: "ACTIVE" },
      update: { planId: "STARTER", status: "ACTIVE" },
    });
  }
});

test.afterAll(async () => {
  await cleanup();
  await prisma.shopSubscription.deleteMany({ where: { shop: { in: [TEST_SHOP, OTHER_SHOP] } } });
  await storeVisualWorker?.close();
  await generationWorker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
});

test.beforeEach(async ({ page }) => {
  await cleanup();
  await page.setExtraHTTPHeaders(HEADER);
  await page.addInitScript(() => {
    Object.assign(window, { shopify: { toast: { show: () => {} } } });
  });
});

test.describe("Store Visuals — create, review, regenerate", () => {
  test("create a homepage hero with no product, approve, regenerate, and the previous approved result remains", async ({
    page,
  }) => {
    await page.goto("/app/store-visuals");
    // The route's own `<s-page heading="...">` doesn't render as an
    // accessible ARIA heading (same pattern every other e2e spec already
    // works around — see e.g. generation.spec.ts's `s-section` scoping);
    // its `<s-section heading="Store Visuals">` does.
    await expect(page.getByRole("heading", { name: "Store Visuals" })).toBeVisible();

    // Default visual type is already "Homepage hero" — no product
    // selection needed (store visuals support zero products).
    await page.getByRole("button", { name: /Generate Homepage hero/ }).click();

    // → redirected to the new job's detail page → queued/processing →
    // succeeded.
    await expect(page).toHaveURL(/\/app\/store-visuals\/[a-z0-9]+$/, { timeout: 10_000 });
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    // → Approve.
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible();

    const firstJobUrl = page.url();

    // → Regenerate → navigates to a NEW job (unlike product-imagery's
    // in-place regenerate — see app.store-visuals.$jobId.tsx's doc
    // comment). `toHaveURL` against the same "/app/store-visuals/<id>"
    // shape the page is ALREADY on wouldn't actually wait for anything
    // (it'd match trivially pre-click too) — `waitForURL` with a
    // not-equal predicate is what genuinely waits for the navigation.
    await page.getByRole("button", { name: "Regenerate" }).click();
    await page.waitForURL((url) => url.toString() !== firstJobUrl, { timeout: 10_000 });
    expect(page.url()).not.toBe(firstJobUrl);
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    // → the original job's result is still approved.
    await page.goto(firstJobUrl);
    await expect(page.getByText(/Approved/).first()).toBeVisible();
  });
});

test.describe("AI Assets — cross-domain library", () => {
  test("lists both a product generation and a store visual, newest first, and the Source filter narrows correctly", async ({
    page,
  }) => {
    const product = await seedAnalyzedProduct(TEST_SHOP, "gid://shopify/Product/9500000000001", "Asset Library Test Bag");

    // Seed a product-scoped generation result directly (this file's focus
    // is the Asset Library, not re-driving the generation UI — that's
    // tests/e2e/lifestyle-generation.spec.ts's job).
    await page.goto(`/app/products/${product.id}`);
    await page.getByRole("button", { name: "Generate Image" }).click();
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    // Create a store visual through its own UI.
    await page.goto("/app/store-visuals");
    await page.getByRole("button", { name: /Generate Homepage hero/ }).click();
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    // → AI Assets shows both, most-recent (the store visual) first. Same
    // `<s-page heading>` caveat as above — assert on the section heading.
    await page.goto("/app/assets");
    await expect(page.getByRole("heading", { name: "Everything this shop has generated" })).toBeVisible();
    const rows = page.locator("s-table-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Homepage hero");
    await expect(rows.nth(1)).toContainText("Product cleanup");

    // → filter by source narrows to just the store visual.
    await page.getByLabel("Source").selectOption({ label: "Store visual" });
    await expect(page.locator("s-table-row")).toHaveCount(1);
    await expect(page.locator("s-table-row").first()).toContainText("Homepage hero");
  });

  test("never shows another shop's assets", async ({ page }) => {
    const otherProduct = await seedAnalyzedProduct(OTHER_SHOP, "gid://shopify/Product/9500000000002", "Other Shop Bag");
    // Page-level headers (set once per test in beforeEach) take
    // precedence over context-level ones, so switching shops mid-test
    // must go through the same `page.setExtraHTTPHeaders` mechanism —
    // not `context.setExtraHTTPHeaders`, which the beforeEach's
    // page-level header would otherwise silently override.
    await page.setExtraHTTPHeaders(OTHER_HEADER);
    await page.goto(`/app/products/${otherProduct.id}`);
    await page.getByRole("button", { name: "Generate Image" }).click();
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    // Switch back to the test shop — its Asset Library must be empty.
    await page.setExtraHTTPHeaders(HEADER);
    await page.goto("/app/assets");
    await expect(page.getByText("Nothing here yet", { exact: false })).toBeVisible();
  });
});
