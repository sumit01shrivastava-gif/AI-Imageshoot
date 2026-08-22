/**
 * E2E: Image Generation foundation (Phase 3).
 *
 * Product → Generate Image → queued/processing → succeeded → result
 * visible → Regenerate → a second, independent generation exists.
 *
 * Same pattern as tests/e2e/product-intelligence.spec.ts: the web app
 * under test runs in a separate process (playwright.config.ts's
 * webServer), so "Generate Image" only *enqueues* a real BullMQ job
 * there; this file runs an actual `"generation"` worker *in the test
 * process* (both processes share the same Redis/Postgres) rather than
 * mocking generation away — see the Phase 3 instructions ("do not mock
 * away the queue").
 *
 * Generation requires a READY Product Intelligence profile (see
 * docs/generation.md "Identity preservation") — seeded directly via
 * Prisma here rather than re-driving Phase 2's own "Analyze Product" UI
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

const TEST_SHOP = "e2e-generation-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };
const PRODUCT_ID = "gid://shopify/Product/9200000000001";

const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let worker: ReturnType<typeof createWorker<GenerationJobPayload>> | undefined;

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.creditReservation.deleteMany({ where: { shop: TEST_SHOP } });
}

async function seedAnalyzedProduct() {
  await cleanup();
  const product = await prisma.shopifyProduct.create({
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
            shopifyMediaId: "gid://shopify/MediaImage/9200000000001",
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

  // Seeded directly (not via "Analyze Product") — see module doc comment.
  await prisma.productIntelligence.create({
    data: {
      shop: TEST_SHOP,
      productId: product.id,
      status: "READY",
      category: "Furniture",
      material: "Wood",
      primaryColor: "Brown",
      modelSuitable: false,
      recommendedAssetTypes: ["product_studio", "scene"],
      recommendedEnvironments: ["studio", "living room"],
      identityAnchors: {
        category: "Furniture",
        shape: null,
        material: "Wood",
        primaryColor: "Brown",
        constructionDetails: [],
        distinctiveHardware: [],
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
  await page.setExtraHTTPHeaders(HEADER);
  await page.addInitScript(() => {
    Object.assign(window, { shopify: { toast: { show: () => {} } } });
  });
});

test.describe("Image Generation", () => {
  test("Generate Image moves from not-generated to a succeeded result, and Regenerate creates a second generation", async ({
    page,
  }) => {
    const product = await seedAnalyzedProduct();

    // Product → product detail. "Not generated yet" is shared vocabulary
    // with Phase 5's "AI Lifestyle Imagery" section (GENERATION_STATUS_LABEL/
    // _TONE are reused across both — see app.products.$id.tsx), so scope
    // to the "Image Generation" (PRODUCT_CLEANUP) section specifically
    // rather than asserting the text page-wide.
    await page.goto(`/app/products/${product.id}`);
    const generationSection = page.locator("s-section", { has: page.getByRole("heading", { name: "Image Generation" }) });
    await expect(generationSection).toBeVisible();
    await expect(generationSection.getByText("Not generated yet", { exact: true })).toBeVisible();

    // → Generate Image.
    const generateButton = page.getByRole("button", { name: "Generate Image" });
    await expect(generateButton).toBeVisible();
    await expect(generateButton).toBeEnabled(); // Product Intelligence is READY
    await generateButton.click();

    // → queued/processing → succeeded (the in-test worker races the UI's
    // 3s auto-poll — whichever the merchant would actually see, the end
    // state is what matters here).
    await expect(page.getByText("Succeeded", { exact: true })).toBeVisible({ timeout: 15_000 });

    // → result visible (metadata card — see app.products.$id.tsx's
    // GenerationResultCard doc comment for why this is metadata, not a
    // rendered photo, with only the deterministic test provider wired up).
    await expect(page.getByText("Result 1", { exact: true })).toBeVisible();
    await expect(page.getByText(/1×1/)).toBeVisible();

    // → Regenerate is now offered instead of the initial "Generate Test
    // Image".
    const regenerateButton = page.getByRole("button", { name: "Regenerate" });
    await expect(regenerateButton).toBeVisible();

    // → Regenerate → a second, independent generation exists (history
    // preserved, not overwritten — docs/generation.md "Generation
    // history").
    await regenerateButton.click();
    await expect(page.getByText("Generation history", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Generation #2", { exact: false })).toBeVisible();
    await expect(page.getByText("Generation #1", { exact: false })).toBeVisible();
  });
});
