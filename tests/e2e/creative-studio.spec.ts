/**
 * E2E: the AI Creative Studio — conversational image creation/editing.
 *
 * Product detail → "Create with AI" → send a natural-language instruction
 * → real queue/worker/deterministic-provider seam → result appears →
 * follow-up instruction uses the previous result as context → multiple
 * variations → select a result → regenerate → verify history remains.
 * Tenant isolation checked at the route layer.
 *
 * Same pattern as tests/e2e/lifestyle-generation.spec.ts: the web app
 * under test runs in a separate process (playwright.config.ts's
 * `webServer`); this file runs a real `"generation"` worker *in the test
 * process* (both share the same Redis/Postgres) rather than mocking
 * generation away.
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

const TEST_SHOP = "e2e-creative-studio-shop.myshopify.com";
const OTHER_SHOP = "e2e-creative-studio-other-shop.myshopify.com";
const HEADER = { "x-ai-imageshoot-e2e-shop": TEST_SHOP };
const OTHER_HEADER = { "x-ai-imageshoot-e2e-shop": OTHER_SHOP };
const PRODUCT_ID = "gid://shopify/Product/9700000000001";

const PLACEHOLDER_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let worker: ReturnType<typeof createWorker<GenerationJobPayload>> | undefined;

async function cleanup() {
  for (const shop of [TEST_SHOP, OTHER_SHOP]) {
    await prisma.creativeMessage.deleteMany({ where: { shop } });
    await prisma.creativeSession.deleteMany({ where: { shop } });
    await prisma.creditReservation.deleteMany({ where: { shop } });
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
      description: "A handcrafted leather tote.",
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

/**
 * Waits until this session has at least `count` GenerationJob rows, ALL
 * terminal (SUCCEEDED/FAILED) — deliberately NOT gated on any UI signal.
 * A UI check like "the canvas image is attached" is trivially already
 * true from a PRIOR turn's result, so it races ahead of a follow-up
 * message's own job even being created yet; polling the actual row
 * count directly is what genuinely proves the new turn has landed. See
 * this spec's own module doc comment.
 */
async function waitForJobCount(shop: string, sessionId: string, count: number, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const jobs = await prisma.generationJob.findMany({
      where: { shop, creativeSessionId: sessionId },
      orderBy: { createdAt: "asc" },
    });
    const allTerminal = jobs.every((j) => j.status === "SUCCEEDED" || j.status === "FAILED");
    if (jobs.length >= count && allTerminal) return jobs;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${count} terminal jobs; found ${jobs.length} (statuses: ${jobs.map((j) => j.status).join(", ")})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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

test.describe("Creative Studio — conversational generation", () => {
  test(
    "start a session, send an instruction, see the result, send a follow-up, create variations, select one, and regenerate — history remains",
    async ({ page }) => {
      // Several sequential real generation round-trips — beyond
      // playwright.config.ts's default 30s test timeout.
      test.setTimeout(60000);

      const product = await seedAnalyzedProduct(TEST_SHOP, PRODUCT_ID, "Creative Studio Test Tote");

      // Product detail → "Create with AI".
      await page.goto(`/app/products/${product.id}`);
      const studioSection = page.locator("s-section", { has: page.getByRole("heading", { name: "AI Creative Studio" }) });
      await expect(studioSection).toBeVisible();
      await studioSection.getByRole("button", { name: "Create with AI" }).click();

      // → redirected into the Creative Studio chat. The route's own
      // `<s-page heading="...">` doesn't render as an accessible ARIA
      // heading — same caveat every other E2E spec in this codebase
      // already works around — its `<s-section heading="...">`s do.
      await expect(page).toHaveURL(/\/app\/creative\/[a-z0-9]+$/, { timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();

      // Initial empty state offers example prompts.
      await expect(page.getByText("Put my product in a premium lifestyle scene")).toBeVisible();

      const sessionId = page.url().split("/").pop()!;

      // → send a first instruction.
      await page.getByRole("textbox", { name: "Message" }).fill("Put my product in a premium lifestyle scene");
      await page.getByRole("button", { name: "Send" }).click();

      // Poll the real row count/status directly rather than a UI signal
      // — see `waitForJobCount`'s doc comment for why.
      await waitForJobCount(TEST_SHOP, sessionId, 1);

      // → the result appears (real queue/worker/deterministic-provider
      // seam) and becomes the canvas' current image automatically.
      // `toBeAttached`, not `toBeVisible` — the deterministic test
      // provider's output is a genuine 1x1 pixel PNG (see
      // deterministic-test-provider.server.ts), which some browsers'
      // visibility heuristics don't treat as "visible"; a real signed
      // `src` resolving and the element existing is what actually
      // matters here.
      await expect(page.getByText("Your images are ready.")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("s-image[alt='Current Creative Studio result']")).toBeAttached({ timeout: 15_000 });

      // → a follow-up instruction uses the previous result as context
      // (real image-to-image wiring, verified via the persisted plan
      // below) rather than starting over from nothing.
      await page.getByRole("textbox", { name: "Message" }).fill("Make it brighter");
      await page.getByRole("button", { name: "Send" }).click();

      const jobsAfterFollowUp = await waitForJobCount(TEST_SHOP, sessionId, 2);
      expect(jobsAfterFollowUp).toHaveLength(2);
      const secondPlan = jobsAfterFollowUp[1].plan as unknown as { referenceImages: Array<{ role: string }> };
      expect(secondPlan.referenceImages[0]?.role).toBe("previous_result");
      await expect(page.locator("s-image[alt='Current Creative Studio result']")).toBeAttached({ timeout: 15_000 });

      // → create multiple variations via the "Create variation" action.
      await page.getByRole("button", { name: "Create variation" }).click();
      await waitForJobCount(TEST_SHOP, sessionId, 3);
      await expect(page.getByText("Your images are ready.")).toBeVisible({ timeout: 15_000 });

      // → Approve the current result.
      await page.getByRole("button", { name: "Approve" }).click();
      await expect(page.getByText(/Approved/).first()).toBeVisible();

      // → Regenerate → a new, independent job; the full conversation
      // history (every prior message) remains intact.
      await page.getByRole("button", { name: "Regenerate" }).click();
      const finalJobs = await waitForJobCount(TEST_SHOP, sessionId, 4);
      await expect(page.locator("s-image[alt='Current Creative Studio result']")).toBeAttached({ timeout: 15_000 });

      expect(finalJobs.length).toBeGreaterThanOrEqual(4);
      const messages = await prisma.creativeMessage.findMany({ where: { shop: TEST_SHOP, creativeSessionId: sessionId } });
      // Every USER message is still there — nothing overwritten.
      expect(messages.filter((m) => m.role === "USER").length).toBeGreaterThanOrEqual(4);
    },
  );

  test("never lets a shop open another shop's Creative Studio session", async ({ page }) => {
    const otherProduct = await seedAnalyzedProduct(OTHER_SHOP, "gid://shopify/Product/9700000000002", "Other Shop Tote");
    await page.setExtraHTTPHeaders(OTHER_HEADER);
    await page.goto(`/app/products/${otherProduct.id}`);
    const studioSection = page.locator("s-section", { has: page.getByRole("heading", { name: "AI Creative Studio" }) });
    await studioSection.getByRole("button", { name: "Create with AI" }).click();
    await expect(page).toHaveURL(/\/app\/creative\/[a-z0-9]+$/, { timeout: 10_000 });
    const otherSessionUrl = page.url();

    // Switch back to the test shop — the same session URL must 404.
    await page.setExtraHTTPHeaders(HEADER);
    const response = await page.goto(otherSessionUrl);
    expect(response?.status()).toBe(404);
  });
});
