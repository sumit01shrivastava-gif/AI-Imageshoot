/**
 * E2E: the Products → image selection workflow (Phase 1).
 *
 * Authenticates via the E2E test seam (see
 * services/shopify/admin-context.server.ts) instead of real Shopify OAuth —
 * every request in this file carries the `x-ai-imageshoot-e2e-shop` header,
 * which playwright.config.ts's webServer only honors because it also sets
 * NODE_ENV=test and ALLOW_E2E_AUTH_BYPASS=1. No live/production Shopify
 * store or AI provider is called — fixture data is seeded directly into the
 * local test Postgres before the suite runs.
 */
import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";

const prisma = new PrismaClient();

const TEST_SHOP = "e2e-test-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };

const BAG_PRODUCT_ID = "gid://shopify/Product/9000000000001";
const TOTE_PRODUCT_ID = "gid://shopify/Product/9000000000002";

// A 1x1 transparent PNG data URL — a real image URL isn't needed since the
// test never asserts on decoded pixel content, only that <s-image>/
// <s-thumbnail> elements render with the expected `src`/`alt`.
const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function seedFixtures() {
  await prisma.imageSelection.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.shopSyncState.deleteMany({ where: { shop: TEST_SHOP } });

  const bag = await prisma.shopifyProduct.create({
    data: {
      shop: TEST_SHOP,
      shopifyProductId: BAG_PRODUCT_ID,
      title: "Premium Leather Bag",
      handle: "premium-leather-bag",
      description: "A handcrafted leather bag.",
      productType: "Bags",
      vendor: "Acme",
      tags: ["leather", "bestseller"],
      status: "ACTIVE",
      shopifyCreatedAt: new Date("2026-01-01T00:00:00Z"),
      shopifyUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      media: {
        create: [
          {
            shop: TEST_SHOP,
            shopifyProductId: BAG_PRODUCT_ID,
            shopifyMediaId: "gid://shopify/MediaImage/1",
            mediaType: "IMAGE",
            originalUrl: PLACEHOLDER_IMAGE,
            previewUrl: PLACEHOLDER_IMAGE,
            altText: "Bag front",
            position: 0,
          },
          {
            shop: TEST_SHOP,
            shopifyProductId: BAG_PRODUCT_ID,
            shopifyMediaId: "gid://shopify/MediaImage/2",
            mediaType: "IMAGE",
            originalUrl: PLACEHOLDER_IMAGE,
            previewUrl: PLACEHOLDER_IMAGE,
            altText: "Bag side",
            position: 1,
          },
        ],
      },
    },
  });

  const tote = await prisma.shopifyProduct.create({
    data: {
      shop: TEST_SHOP,
      shopifyProductId: TOTE_PRODUCT_ID,
      title: "Canvas Tote",
      handle: "canvas-tote",
      description: "A simple canvas tote.",
      productType: "Bags",
      vendor: "Acme",
      tags: ["canvas"],
      status: "DRAFT",
      shopifyCreatedAt: new Date("2026-01-03T00:00:00Z"),
      shopifyUpdatedAt: new Date("2026-01-03T00:00:00Z"),
      media: {
        create: [
          {
            shop: TEST_SHOP,
            shopifyProductId: TOTE_PRODUCT_ID,
            shopifyMediaId: "gid://shopify/MediaImage/3",
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

  await prisma.shopSyncState.create({
    data: { shop: TEST_SHOP, status: "IDLE", lastSyncedAt: new Date() },
  });

  return { bagId: bag.id, toteId: tote.id };
}

async function cleanupFixtures() {
  await prisma.imageSelection.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.shopifyProduct.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.shopSyncState.deleteMany({ where: { shop: TEST_SHOP } });
  await prisma.$disconnect();
}

test.beforeAll(async () => {
  await seedFixtures();
});

test.afterAll(async () => {
  await cleanupFixtures();
});

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders(HEADER);
  // These tests navigate directly rather than through a real embedded
  // Shopify iframe, so App Bridge's `window.shopify` global (normally
  // injected by the Shopify-hosted script tag) never appears. Stub the one
  // surface this app's Phase 1 UI calls (`shopify.toast.show`) so
  // `useAppBridge()` doesn't throw — see
  // app/routes/app.products._index.tsx / app.products.selection.tsx.
  await page.addInitScript(() => {
    Object.assign(window, { shopify: { toast: { show: () => {} } } });
  });
});

async function gotoProducts(page: Page) {
  await page.goto("/app/products");
  // Polaris's <s-page heading> doesn't expose an ARIA `heading` role in the
  // rendered accessibility tree, so page identity is asserted from
  // distinctive on-page content instead of a heading role/name throughout
  // this file.
  await expect(page.getByRole("button", { name: "Select all on this page" })).toBeVisible();
}

test.describe("Products → image selection", () => {
  test("products load, can be searched, opened, and images selected across products", async ({
    page,
  }) => {
    // 1 & 2. Open Products page; products load.
    await gotoProducts(page);
    await expect(page.getByRole("link", { name: "Premium Leather Bag" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Canvas Tote" })).toBeVisible();

    // 3. Search works.
    const search = page.getByRole("searchbox", { name: "Search products" });
    await search.fill("Canvas");
    await search.blur();
    await expect(page.getByRole("link", { name: "Canvas Tote" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Premium Leather Bag" })).toHaveCount(0);
    await search.fill("");
    await search.blur();
    await expect(page.getByRole("link", { name: "Premium Leather Bag" })).toBeVisible();

    // 4. Product can be opened.
    await page.getByRole("link", { name: "Premium Leather Bag" }).click();
    await expect(page).toHaveURL(/\/app\/products\/[a-z0-9]+$/);
    await expect(page.getByText("Images (2)")).toBeVisible();

    // 5. Images are displayed.
    const bagImages = page.getByRole("checkbox", { name: /^Select image/ });
    await expect(bagImages).toHaveCount(2);

    // 6. One image can be selected.
    await bagImages.nth(0).check();
    await expect(page.getByText(/1 product selected · 1 source image/)).toBeVisible();

    // 7. Multiple images can be selected.
    await bagImages.nth(1).check();
    await expect(page.getByText(/1 product selected · 2 source images/)).toBeVisible();

    // 8. Multiple products can be selected.
    await page.getByRole("link", { name: "Products" }).click();
    await expect(page.getByRole("button", { name: "Select all on this page" })).toBeVisible();
    const toteRowCheckbox = page.getByRole("checkbox", { name: "Select all images for Canvas Tote" });
    await toteRowCheckbox.check();
    await expect(page.getByText(/2 products selected · 3 source images/)).toBeVisible();

    // 9. Selection summary is correct.
    await page.getByRole("button", { name: "Review & Continue" }).click();
    await expect(page.getByText("Selected: 2 products, 3 source images.")).toBeVisible();
    await expect(page.getByText("Premium Leather Bag (2)")).toBeVisible();
    await expect(page.getByText("Canvas Tote (1)")).toBeVisible();

    // Continue persists the selection (no generation starts).
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/2 products and 3 source images were saved/)).toBeVisible();
  });
});
