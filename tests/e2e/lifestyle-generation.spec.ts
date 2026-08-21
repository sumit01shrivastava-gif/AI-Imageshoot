/**
 * E2E: AI Lifestyle Product Imagery (Phase 5).
 *
 * Single-product flow: Product detail → pick a brand style preset →
 * Generate Lifestyle Image → queued/processing → succeeded → result
 * visible → Approve → Regenerate → verify the previous (approved) result
 * remains in history.
 *
 * Batch flow: Products → select multiple products → choose "Generate
 * lifestyle imagery" mode → pick a preset → start generating → batch
 * progress page → completed results → review → approve → regenerate →
 * verify the previous result remains.
 *
 * Same pattern as tests/e2e/generation.spec.ts / tests/e2e/processing.spec.ts:
 * the web app under test runs in a separate process (playwright.config.ts's
 * `webServer`), so the UI only *enqueues* real BullMQ jobs there; this file
 * runs an actual `"generation"` worker *in the test process* (both
 * processes share the same Redis/Postgres) rather than mocking generation
 * away — see the Phase 3/4/5 instructions ("do not mock away the queue").
 *
 * Generation requires a READY Product Intelligence profile — seeded
 * directly via Prisma here rather than re-driving the "Analyze Product" UI
 * flow, which tests/e2e/product-intelligence.spec.ts already covers.
 */
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "deterministic-test";

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetEnvCacheForTests } from "../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../lib/queue";
import { processGenerationJob } from "../../services/generation/job.server";
import type { GenerationJobPayload } from "../../services/generation/job.server";

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6380";
resetEnvCacheForTests();

const prisma = new PrismaClient();

const TEST_SHOP = "e2e-lifestyle-generation-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };
const DETAIL_PRODUCT_ID = "gid://shopify/Product/9400000000001";
const BAG_PRODUCT_ID = "gid://shopify/Product/9400000000002";
const TOTE_PRODUCT_ID = "gid://shopify/Product/9400000000003";

const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let worker: ReturnType<typeof createWorker<GenerationJobPayload>> | undefined;

async function cleanup() {
  await prisma.generationBatch.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.imageSelection.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: TEST_SHOP } });
}

async function seedAnalyzedProduct(shopifyProductId: string, title: string) {
  const product = await prisma.shopifyProduct.create({
    data: {
      shop: TEST_SHOP,
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
            shop: TEST_SHOP,
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
      shop: TEST_SHOP,
      productId: product.id,
      status: "READY",
      category: "Handbags",
      material: "Leather",
      primaryColor: "Brown",
      modelSuitable: false,
      recommendedAssetTypes: ["product_studio", "lifestyle"],
      recommendedEnvironments: ["studio", "upscale interior"],
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
  worker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));
});

test.afterAll(async () => {
  await cleanup();
  await worker?.close();
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

test.describe("AI Lifestyle Imagery — product detail", () => {
  test("pick a preset, generate, approve, regenerate, and verify the previous approved result remains", async ({
    page,
  }) => {
    const product = await seedAnalyzedProduct(DETAIL_PRODUCT_ID, "Lifestyle Detail Test Bag");

    // Product → product detail. "Not generated yet" is shared vocabulary
    // with the pre-existing PRODUCT_CLEANUP "Image Generation" section
    // (GENERATION_STATUS_LABEL/_TONE are reused across both — see
    // app.products.$id.tsx), so scope to this section specifically rather
    // than asserting the text page-wide.
    await page.goto(`/app/products/${product.id}`);
    const lifestyleSection = page.locator("s-section", { has: page.getByRole("heading", { name: "AI Lifestyle Imagery" }) });
    await expect(lifestyleSection).toBeVisible();
    await expect(lifestyleSection.getByText("Not generated yet", { exact: true })).toBeVisible();

    // → pick a brand style preset.
    await page.getByLabel("Brand style").selectOption({ label: "Luxury Editorial" });

    // → Generate Lifestyle Image.
    const generateButton = page.getByRole("button", { name: "Generate Lifestyle Image" });
    await expect(generateButton).toBeVisible();
    await expect(generateButton).toBeEnabled(); // Product Intelligence is READY
    await generateButton.click();

    // → queued/processing → succeeded (the in-test worker races the UI's
    // 3s auto-poll — whichever the merchant would actually see, the end
    // state is what matters here). "Succeeded" legitimately appears twice
    // once a result exists (the section's own status badge, and the
    // result card's own badge — mirrors
    // tests/e2e/processing.spec.ts's identical handling), so match the
    // first rather than requiring page-wide uniqueness.
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    // → result visible, original vs. generated side by side.
    await expect(page.getByText("Lifestyle result", { exact: true })).toBeVisible();
    await expect(page.getByText("Not reviewed", { exact: false })).toBeVisible();

    // → verify original still exists — Shopify's own media row is
    // untouched.
    const media = await prisma.shopifyProductMedia.findFirstOrThrow({
      where: { shop: TEST_SHOP, shopifyProductId: DETAIL_PRODUCT_ID },
    });
    expect(media.originalUrl).toBe(PLACEHOLDER_IMAGE);

    // → Approve.
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible();

    // → Regenerate → a second, independent generation exists (history
    // preserved, not overwritten). Exactly one "Regenerate" control exists
    // once a result exists (the section's own top-level button is only
    // offered pre-result — see app.products.$id.tsx's AI Lifestyle
    // Imagery section).
    await page.getByRole("button", { name: "Regenerate" }).click();
    await expect(page.getByText("Lifestyle generation history", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Generation #2", { exact: false })).toBeVisible();
    await expect(page.getByText("Generation #1", { exact: false })).toBeVisible();

    // → the previous (approved) result remains — the history line for
    // Generation #1 still reads Approved even though the "Lifestyle
    // result" card up top now shows the fresh, unreviewed regeneration.
    await expect(page.getByText(/Generation #1.*Approved/)).toBeVisible();
  });
});

test.describe("AI Lifestyle Imagery — batch generation", () => {
  test("select multiple products, choose Generate lifestyle imagery, start, watch batch progress, review, approve, and regenerate preserving the previous result", async ({
    page,
  }) => {
    await seedAnalyzedProduct(BAG_PRODUCT_ID, "Lifestyle Batch Test Bag");
    await seedAnalyzedProduct(TOTE_PRODUCT_ID, "Lifestyle Batch Test Tote");

    // Products → select multiple products.
    await page.goto("/app/products");
    await expect(page.getByRole("button", { name: "Select all on this page" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all images for Lifestyle Batch Test Bag" }).check();
    await page.getByRole("checkbox", { name: "Select all images for Lifestyle Batch Test Tote" }).check();
    await expect(page.getByText(/2 products selected · 2 source images/)).toBeVisible();

    await page.getByRole("button", { name: "Review & Continue" }).click();
    await expect(page.getByText("Selected: 2 products, 2 source images.")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/2 products and 2 source images were saved/)).toBeVisible();

    // → choose "Generate lifestyle imagery" mode → pick a preset.
    await page.getByLabel("Mode").selectOption({ label: "Generate lifestyle imagery" });
    await page.getByLabel("Brand style").selectOption({ label: "Natural Lifestyle" });

    // → start generating.
    await expect(page.getByRole("button", { name: "Start generating" })).toBeVisible();
    await page.getByRole("button", { name: "Start generating" }).click();

    // → redirected into the batch progress page.
    await expect(page).toHaveURL(/\/app\/generation\/[a-z0-9]+$/);

    // → batch progress → completed results.
    await expect(page.getByText("2 of 2 completed (100%)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(2);

    // → review result → approve.
    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect(page.getByText(/Approved/)).toBeVisible();

    // → regenerate → a third, independent job joins the same batch.
    await page.getByRole("button", { name: "Regenerate" }).first().click();
    await expect(page.getByText("3 of 3 completed (100%)")).toBeVisible({ timeout: 15_000 });

    // → verify the previous (approved) result remains, untouched by the
    // regenerate of a different job.
    await expect(page.getByText(/Approved/)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(3);
  });
});
