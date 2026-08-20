/**
 * E2E: Batch image processing (Phase 4).
 *
 * Products → select multiple products → choose Background Removal →
 * start processing → batch progress → completed results → review result
 * → approve → regenerate → verify the previous result remains.
 *
 * Same pattern as tests/e2e/product-intelligence.spec.ts /
 * tests/e2e/generation.spec.ts: the web app under test runs in a
 * separate process (playwright.config.ts's `webServer`), so "Start
 * processing" only *enqueues* real BullMQ jobs there; this file runs an
 * actual `"enhancement"` worker *in the test process* (both processes
 * share the same Redis/Postgres/local storage root — see
 * playwright.config.ts's doc comment for why `STORAGE_LOCAL_ROOT`/
 * `MEDIA_SIGNING_SECRET` are fixed, matching literals here and there)
 * rather than mocking processing away — see the Phase 4 instructions
 * ("do not mock away the queue").
 */
process.env.NODE_ENV = "test";
process.env.IMAGE_PROCESSING_PROVIDER = "deterministic-test";
process.env.STORAGE_LOCAL_ROOT = "/tmp/ai-imageshoot-e2e-storage";
process.env.MEDIA_SIGNING_SECRET = "e2e_test_media_signing_secret";

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { rm } from "node:fs/promises";
import { resetEnvCacheForTests } from "../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../lib/queue";
import { processProcessingJob } from "../../services/processing/job.server";
import type { ProcessingJobPayload } from "../../services/processing/job.server";

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6380";
resetEnvCacheForTests();

const prisma = new PrismaClient();

const TEST_SHOP = "e2e-processing-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };
const BAG_PRODUCT_ID = "gid://shopify/Product/9300000000001";
const TOTE_PRODUCT_ID = "gid://shopify/Product/9300000000002";
const DETAIL_PRODUCT_ID = "gid://shopify/Product/9300000000003";

const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let worker: ReturnType<typeof createWorker<ProcessingJobPayload>> | undefined;

async function cleanup() {
  await prisma.processingBatch.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.imageSelection.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: TEST_SHOP } });
}

async function seedProducts() {
  await cleanup();
  await prisma.shopifyProduct.create({
    data: {
      shop: TEST_SHOP,
      shopifyProductId: BAG_PRODUCT_ID,
      title: "Processing Test Bag",
      handle: "processing-test-bag",
      description: "A bag for processing tests.",
      productType: "Bags",
      vendor: "Acme",
      tags: [],
      status: "ACTIVE",
      shopifyCreatedAt: new Date("2026-01-01T00:00:00Z"),
      shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      media: {
        create: [
          {
            shop: TEST_SHOP,
            shopifyProductId: BAG_PRODUCT_ID,
            shopifyMediaId: "gid://shopify/MediaImage/9300000000001",
            mediaType: "IMAGE",
            originalUrl: PLACEHOLDER_IMAGE,
            previewUrl: PLACEHOLDER_IMAGE,
            altText: "Bag front",
            position: 0,
          },
        ],
      },
    },
  });
  await prisma.shopifyProduct.create({
    data: {
      shop: TEST_SHOP,
      shopifyProductId: TOTE_PRODUCT_ID,
      title: "Processing Test Tote",
      handle: "processing-test-tote",
      description: "A tote for processing tests.",
      productType: "Bags",
      vendor: "Acme",
      tags: [],
      status: "ACTIVE",
      shopifyCreatedAt: new Date("2026-01-01T00:00:00Z"),
      shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      media: {
        create: [
          {
            shop: TEST_SHOP,
            shopifyProductId: TOTE_PRODUCT_ID,
            shopifyMediaId: "gid://shopify/MediaImage/9300000000002",
            mediaType: "IMAGE",
            originalUrl: PLACEHOLDER_IMAGE,
            previewUrl: PLACEHOLDER_IMAGE,
            altText: "Tote front",
            position: 0,
          },
        ],
      },
    },
  });
}

/** Single product used by the product-detail flow test — kept separate
 * from `seedProducts()`'s pair (used by the batch flow) so the two
 * scenarios don't interfere; `cleanup()` wipes every product for this
 * shop regardless of which seed created it. */
async function seedDetailProduct() {
  await cleanup();
  return prisma.shopifyProduct.create({
    data: {
      shop: TEST_SHOP,
      shopifyProductId: DETAIL_PRODUCT_ID,
      title: "Processing Detail Test Chair",
      handle: "processing-detail-test-chair",
      description: "A chair for the product-detail processing test.",
      productType: "Furniture",
      vendor: "Acme",
      tags: [],
      status: "ACTIVE",
      shopifyCreatedAt: new Date("2026-01-01T00:00:00Z"),
      shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      media: {
        create: [
          {
            shop: TEST_SHOP,
            shopifyProductId: DETAIL_PRODUCT_ID,
            shopifyMediaId: "gid://shopify/MediaImage/9300000000003",
            mediaType: "IMAGE",
            originalUrl: PLACEHOLDER_IMAGE,
            previewUrl: PLACEHOLDER_IMAGE,
            altText: "Chair front",
            position: 0,
          },
        ],
      },
    },
  });
}

test.beforeAll(async () => {
  worker = createWorker<ProcessingJobPayload>("enhancement", processProcessingJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));
});

test.afterAll(async () => {
  await cleanup();
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  await rm("/tmp/ai-imageshoot-e2e-storage", { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(HEADER);
  await page.addInitScript(() => {
    Object.assign(window, { shopify: { toast: { show: () => {} } } });
  });
});

test.describe("Batch image processing", () => {
  test("select multiple products, start background removal, watch batch progress, review, approve, and regenerate preserving the previous result", async ({
    page,
  }) => {
    await seedProducts();

    // Products → select multiple products.
    await page.goto("/app/products");
    await expect(page.getByRole("button", { name: "Select all on this page" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all images for Processing Test Bag" }).check();
    await page.getByRole("checkbox", { name: "Select all images for Processing Test Tote" }).check();
    await expect(page.getByText(/2 products selected · 2 source images/)).toBeVisible();

    await page.getByRole("button", { name: "Review & Continue" }).click();
    await expect(page.getByText("Selected: 2 products, 2 source images.")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/2 products and 2 source images were saved/)).toBeVisible();

    // Choose Background Removal (the default) → start processing.
    await expect(page.getByRole("button", { name: "Start processing" })).toBeVisible();
    await page.getByRole("button", { name: "Start processing" }).click();

    // → redirected into the batch progress page.
    await expect(page).toHaveURL(/\/app\/processing\/[a-z0-9]+$/);

    // → batch progress → completed results.
    await expect(page.getByText("2 of 2 completed (100%)")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Regenerate" })).toHaveCount(2);

    // Media serving: the "Processed" thumbnail's src is a signed
    // /media/<key>?expires=...&sig=... URL (lib/storage/
    // local-filesystem-provider.server.ts) served by the web server
    // process from bytes the worker (this test process) wrote — fetch it
    // for real and confirm it's actually served, tenant-authorized only
    // via its signature (see app/routes/media.$.tsx), not a filesystem
    // path or an unauthenticated arbitrary-file endpoint.
    const processedImageSrc = await page.locator('img[alt^="Processed —"]').first().getAttribute("src");
    expect(processedImageSrc).toMatch(/^\/media\/shops\/e2e-processing-shop\.myshopify\.com\/processing\//);
    const mediaResponse = await page.request.get(processedImageSrc!);
    expect(mediaResponse.status()).toBe(200);
    expect(mediaResponse.headers()["content-type"]).toBe("image/png");
    // Tampering with the signature must not be servable — flip the first
    // hex character of `sig` to a different, still-valid hex digit (a
    // naive "append garbage" tamper doesn't actually corrupt a hex
    // string: Buffer.from(..., "hex") silently drops trailing bytes past
    // the last complete valid pair).
    const tamperedUrl = processedImageSrc!.replace(/sig=([0-9a-f])/, (_match, first: string) =>
      `sig=${first === "0" ? "1" : "0"}`,
    );
    const tamperedResponse = await page.request.get(tamperedUrl);
    expect(tamperedResponse.status()).toBe(404);

    // → review result → approve. The review-status word is rendered
    // alongside format/dimensions in one text node (e.g. "png · 1×1 ·
    // Approved"), so match it as a substring, not the whole element.
    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect(page.getByText(/Approved/)).toBeVisible();

    // → regenerate → a third, independent job joins the same batch.
    await page.getByRole("button", { name: "Regenerate" }).first().click();
    await expect(page.getByText("3 of 3 completed (100%)")).toBeVisible({ timeout: 15_000 });

    // → verify the previous (approved) result remains — untouched by the
    // regenerate of a different job. Exactly one result was ever
    // approved, and it's still shown as such after the regenerate.
    await expect(page.getByText(/Approved/)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(3); // one per job card (the approved one's is disabled, still rendered)
  });
});

test.describe("Product detail processing", () => {
  test("open product detail, see source image, start background removal, observe processing, see completed result, verify original still exists, approve, regenerate, and verify the previous result remains in history", async ({
    page,
  }) => {
    const product = await seedDetailProduct();

    // Product → open product detail → see source image.
    await page.goto(`/app/products/${product.id}`);
    await expect(page.getByRole("heading", { name: "Image Processing" })).toBeVisible();
    await expect(page.getByText("Original", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove background" })).toBeVisible();

    // → start background removal.
    await page.getByRole("button", { name: "Remove background" }).click();

    // → observe processing state → see completed result. The in-test
    // worker races the UI's 3s auto-poll — whichever the merchant would
    // actually see, the end state (a rendered "Latest result" card) is
    // what matters here.
    await expect(page.getByRole("heading", { name: "Latest result" })).toBeVisible({ timeout: 15_000 });
    // "Remove background" now legitimately appears twice (the per-image
    // action button, still offered, and the "Latest result" card's own
    // operation label) — scoped assertions below cover the card itself.
    await expect(page.getByText(/Succeeded/).first()).toBeVisible();

    // → verify original still exists — Shopify's own media row is
    // untouched (this is the authoritative check; the DOM also still
    // shows an "Original" thumbnail, asserted above and unchanged since
    // no navigation occurred).
    const media = await prisma.shopifyProductMedia.findFirstOrThrow({
      where: { shop: TEST_SHOP, shopifyProductId: DETAIL_PRODUCT_ID },
    });
    expect(media.originalUrl).toBe(PLACEHOLDER_IMAGE);

    // → approve result.
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Approved/).first()).toBeVisible();

    // → regenerate.
    await page.getByRole("button", { name: "Regenerate" }).click();
    // The "Latest result" card now reflects the NEW job (freshly queued,
    // then succeeded again).
    await expect(page.getByText("Processing history", { exact: true })).toBeVisible({ timeout: 15_000 });

    // → verify the previous result remains in history — the first job's
    // approval is still shown in the processing history list, even
    // though "Latest result" now shows the regenerated (unapproved) one.
    await expect(page.getByText(/Process #1/)).toBeVisible();
    await expect(page.getByText(/Process #2/)).toBeVisible();
    await expect(page.getByText(/Approved/)).toBeVisible();
  });
});
