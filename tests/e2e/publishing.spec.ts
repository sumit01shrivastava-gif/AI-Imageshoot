/**
 * E2E: Shopify publishing (this pass — see docs/publishing.md).
 *
 * This app currently requests only `read_products` — `write_products`
 * (required by `productCreateMedia`) is deliberately NOT requested yet
 * (see services/shopify/publish-media.server.ts's doc comment and
 * CLAUDE.md's "Do not add Shopify write scopes until ready"). No E2E test
 * shop here has a real Shopify OAuth session on file either way (the
 * `ALLOW_E2E_AUTH_BYPASS` seam only bypasses this app's *own*
 * authentication, not Shopify's), so `unauthenticated.admin(shop)` always
 * throws "no stored session" — a real, honestly-reported publish failure,
 * never a faked success. That is the exact, correct "Failed publishing"
 * scenario this suite is built to exercise (see CLAUDE.md's explicit
 * stop condition: "do not simulate a successful Shopify publish").
 *
 * Scenario 1: Product → generate lifestyle imagery → Approve → Publish →
 * observe the real "Publish failed" state, with a clear merchant-safe
 * message, and see the attempt in the shop-wide Publishing history page.
 * Scenario 2: Store Visual → Approve → Publish → the same honest failure.
 * Scenario 3 (folded into both above): Publishing history lists both
 * attempts with source/status/date.
 *
 * Same pattern as the other E2E specs: the web app runs in a separate
 * process (playwright.config.ts's `webServer`); this file runs real
 * `"generation"`, `"store-visuals"`, and `"publishing"` workers *in the
 * test process* (shared Redis/Postgres/local storage) rather than mocking
 * any of it away — see CLAUDE.md's "do not mock away the queue".
 */
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "deterministic-test";
process.env.STORAGE_LOCAL_ROOT = "/tmp/ai-imageshoot-e2e-storage";
process.env.MEDIA_SIGNING_SECRET = "e2e_test_media_signing_secret";

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetEnvCacheForTests } from "../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../lib/queue";
import { processGenerationJob } from "../../services/generation/job.server";
import type { GenerationJobPayload } from "../../services/generation/job.server";
import { processStoreVisualJob } from "../../services/store-visuals/job.server";
import type { StoreVisualJobPayload } from "../../services/store-visuals/job.server";
import { processPublishingJob } from "../../services/publishing/job.server";
import type { PublishingJobPayload } from "../../services/publishing/job.server";

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6380";
resetEnvCacheForTests();

const prisma = new PrismaClient();

const TEST_SHOP = "e2e-publishing-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };
const PRODUCT_ID = "gid://shopify/Product/9600000000001";

const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let generationWorker: ReturnType<typeof createWorker<GenerationJobPayload>> | undefined;
let storeVisualWorker: ReturnType<typeof createWorker<StoreVisualJobPayload>> | undefined;
let publishingWorker: ReturnType<typeof createWorker<PublishingJobPayload>> | undefined;

async function cleanup() {
  await prisma.publishingJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.storeVisualJob.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.generationJob.deleteMany({ where: { shop: TEST_SHOP } });
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
  generationWorker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
  storeVisualWorker = createWorker<StoreVisualJobPayload>("store-visuals", processStoreVisualJob);
  publishingWorker = createWorker<PublishingJobPayload>("publishing", processPublishingJob);
  await Promise.all([
    new Promise<void>((resolve) => generationWorker!.on("ready", () => resolve())),
    new Promise<void>((resolve) => storeVisualWorker!.on("ready", () => resolve())),
    new Promise<void>((resolve) => publishingWorker!.on("ready", () => resolve())),
  ]);
});

test.afterAll(async () => {
  await cleanup();
  await generationWorker?.close();
  await storeVisualWorker?.close();
  await publishingWorker?.close();
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

test.describe("Publishing — product imagery", () => {
  test("approve a lifestyle result, publish, and observe the real, honest publish failure", async ({ page }) => {
    const product = await seedAnalyzedProduct(PRODUCT_ID, "Publishing Detail Test Bag");

    await page.goto(`/app/products/${product.id}`);
    await page.getByRole("button", { name: "Generate Lifestyle Image" }).click();
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    // → Approve. Publishing is never automatic on approval (CLAUDE.md
    // "Approval and publishing must remain separate concepts") — no
    // publish attempt exists yet.
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();

    // → Publish → the request is queued immediately (a real PublishingJob
    // row exists as soon as this returns)...
    await page.getByRole("button", { name: "Publish" }).click();

    // → ...and, since no real Shopify OAuth session exists for this test
    // shop, the worker's `unauthenticated.admin(shop)` call genuinely
    // fails — the UI settles on the real, honest "Publish failed" state
    // (never a faked success) within the queue's own retry window
    // (3 attempts, exponential backoff).
    await expect(page.getByText("Publish failed")).toBeVisible({ timeout: 20_000 });

    const publishingJob = await prisma.publishingJob.findFirstOrThrow({
      where: { shop: TEST_SHOP, targetProductId: product.id },
    });
    expect(publishingJob.status).toBe("FAILED");
    expect(publishingJob.sourceType).toBe("GENERATION_RESULT");
    expect(publishingJob.errorMessage).toBeTruthy();
    // Never a raw provider/internal error leaked to a persisted,
    // merchant-visible field (CLAUDE.md "Safe error handling").
    expect(publishingJob.errorMessage).not.toMatch(/stack|prisma|graphql|token/i);

    // → the attempt shows up in the shop-wide Publishing history page.
    await page.goto("/app/publishing");
    await expect(page.getByRole("heading", { name: "Publish history" })).toBeVisible();
    await expect(page.getByText("Product generation", { exact: true })).toBeVisible();
    await expect(page.getByText("Failed", { exact: true })).toBeVisible();
  });
});

test.describe("Publishing — store visuals", () => {
  test("approve a store visual result, publish, and observe the real, honest publish failure", async ({ page }) => {
    const product = await seedAnalyzedProduct("gid://shopify/Product/9600000000002", "Publishing Store Visual Bag");

    // Feature the seeded product — publishing needs at least one
    // candidate target product (see app/components/publish-control.tsx's
    // "no associated product" branch for the zero-product case, already
    // exercised by tests/integration/routes/app.store-visuals-publish-action.test.ts).
    await page.goto("/app/store-visuals");
    await page.getByRole("checkbox", { name: `Feature ${product.title}` }).check();
    await page.getByRole("button", { name: /Generate Homepage hero/ }).click();
    await expect(page).toHaveURL(/\/app\/store-visuals\/[a-z0-9]+$/, { timeout: 10_000 });
    await expect(page.getByText(/Succeeded/).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible();
    await page.getByRole("button", { name: "Publish" }).click();

    await expect(page.getByText("Publish failed")).toBeVisible({ timeout: 20_000 });

    const publishingJob = await prisma.publishingJob.findFirstOrThrow({
      where: { shop: TEST_SHOP, sourceType: "STORE_VISUAL_RESULT" },
    });
    expect(publishingJob.status).toBe("FAILED");

    await page.goto("/app/publishing");
    await expect(page.getByText("Store visual", { exact: true })).toBeVisible();
  });
});
