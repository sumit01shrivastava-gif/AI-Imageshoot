/**
 * E2E: the standalone (non-Shopify) studio — sign up, land in the
 * Creative Studio, start a real conversation (text-only), see the real
 * generated result, send a follow-up, check the Creations gallery, and
 * log out. Same pattern as tests/e2e/creative-studio.spec.ts (a real
 * `"generation"` worker in the test process, the deterministic test
 * provider — never a live vendor call), applied to the NEW standalone
 * entry point rather than the Shopify-embedded one. Tenant isolation
 * between two workspaces is checked at the route layer.
 */
process.env.NODE_ENV = "test";
process.env.AI_PROVIDER = "deterministic-test";

import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { resetEnvCacheForTests } from "../../lib/validation/env.server";
import { createWorker, closeRedisConnection } from "../../lib/queue";
import { processGenerationJob } from "../../services/generation/job.server";
import type { GenerationJobPayload } from "../../services/generation/job.server";

process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5433/ai_imageshoot?schema=public";
process.env.REDIS_URL ??= "redis://localhost:6380";
resetEnvCacheForTests();

const prisma = new PrismaClient();

const EMAIL_A = "e2e-standalone-a@example.com";
const EMAIL_B = "e2e-standalone-b@example.com";
const PASSWORD = "correct-horse-battery-staple";

let worker: ReturnType<typeof createWorker<GenerationJobPayload>> | undefined;

async function cleanupEmail(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;
  const memberships = await prisma.workspaceMembership.findMany({ where: { userId: user.id } });
  for (const membership of memberships) {
    const workspace = await prisma.workspace.findUnique({ where: { id: membership.workspaceId } });
    if (workspace) {
      const shop = workspace.tenantKey;
      await prisma.creditReservation.deleteMany({ where: { shop } });
      await prisma.creativeMessage.deleteMany({ where: { shop } });
      await prisma.generationResult.deleteMany({ where: { shop } });
      await prisma.generationJob.deleteMany({ where: { shop } });
      await prisma.creativeSession.deleteMany({ where: { shop } });
      await prisma.usageEvent.deleteMany({ where: { shop } }).catch(() => undefined);
    }
  }
  await prisma.workspaceMembership.deleteMany({ where: { userId: user.id } });
  await Promise.all(memberships.map((m) => prisma.workspace.delete({ where: { id: m.workspaceId } }).catch(() => undefined)));
  await prisma.userSession.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
}

async function cleanup() {
  await cleanupEmail(EMAIL_A);
  await cleanupEmail(EMAIL_B);
}

async function tenantKeyFor(email: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const membership = await prisma.workspaceMembership.findFirstOrThrow({ where: { userId: user.id }, include: { workspace: true } });
  return membership.workspace.tenantKey;
}

async function waitForJobCount(shop: string, sessionId: string, count: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const jobs = await prisma.generationJob.findMany({ where: { shop, creativeSessionId: sessionId }, orderBy: { createdAt: "asc" } });
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

test.beforeEach(async () => {
  await cleanup();
});

test.describe("Standalone studio — sign up, converse, generate, iterate", () => {
  test(
    "sign up, start a conversation, see the real result, send a follow-up, find it in Creations, and log out",
    async ({ page }) => {
      test.setTimeout(60_000);

      // 1. Unauthenticated visitor is redirected to /login from /studio.
      await page.goto("/studio");
      await expect(page).toHaveURL(/\/login$/);

      // 2. Sign up — a real account + workspace.
      await page.goto("/signup");
      await page.getByLabel("Email").fill(EMAIL_A);
      await page.getByLabel("Password").fill(PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();

      await expect(page).toHaveURL(/\/studio$/, { timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "What do you want to create?" })).toBeVisible();

      const shop = await tenantKeyFor(EMAIL_A);

      // 3+4. A text-only prompt starts a real conversation.
      await page.getByPlaceholder("Describe what you want to create…").fill("Create a clean product photo on a white background");
      await page.getByRole("button", { name: "Send" }).click();

      await expect(page).toHaveURL(/\/studio\/c\/[a-z0-9]+$/, { timeout: 10_000 });
      const sessionId = page.url().split("/").pop()!;

      // 7+8+10+11. The message reached the generation system, a real
      // GenerationJob (productId: null) was created, the worker
      // processed it, and the result appears in the conversation.
      const jobs = await waitForJobCount(shop, sessionId, 1);
      expect(jobs[0].productId).toBeNull();
      await expect(page.getByText("Your image is ready.")).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(".studio-canvas-stage img")).toBeAttached({ timeout: 15_000 });

      // 12+13. A follow-up prompt creates a NEW generation; the previous
      // one remains accessible (both jobs still exist, both with real
      // results).
      await page.getByPlaceholder("Make the background darker…").fill("Make the background darker");
      await page.getByRole("button", { name: "Send" }).click();
      const jobsAfterFollowUp = await waitForJobCount(shop, sessionId, 2);
      expect(jobsAfterFollowUp).toHaveLength(2);
      expect(jobsAfterFollowUp.every((j) => j.status === "SUCCEEDED")).toBe(true);
      await expect(page.getByText("Your image is ready.")).toBeVisible({ timeout: 15_000 });

      // 14+15. The conversation shows up in the sidebar history and in
      // Creations.
      await expect(page.locator(".studio-conv-item", { hasText: "Create a clean product photo" })).toBeVisible();
      await page.getByRole("link", { name: "Creations" }).click();
      await expect(page).toHaveURL(/\/studio\/creations$/);
      await expect(page.locator(".studio-gallery-card", { hasText: "Create a clean product photo" })).toBeVisible();

      // 16. Reopening the conversation from Creations loads the SAME
      // session with its full history, not a fresh one.
      await page.locator(".studio-gallery-card", { hasText: "Create a clean product photo" }).click();
      await expect(page).toHaveURL(new RegExp(`/studio/c/${sessionId}$`));
      await expect(page.locator(".studio-msg", { hasText: "Make the background darker" })).toBeVisible();

      // 17. Logout actually logs out.
      await page.getByRole("button", { name: "Log out" }).click();
      await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 });
      await page.goto("/studio");
      await expect(page).toHaveURL(/\/login$/);
    },
  );

  test("a second workspace can never see the first workspace's conversation", async ({ page, context }) => {
    // Workspace A creates a conversation.
    await page.goto("/signup");
    await page.getByLabel("Email").fill(EMAIL_A);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/studio$/, { timeout: 10_000 });

    await page.getByPlaceholder("Describe what you want to create…").fill("Create a clean product photo");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page).toHaveURL(/\/studio\/c\/[a-z0-9]+$/, { timeout: 10_000 });
    const sessionId = page.url().split("/").pop()!;

    // A fresh, unauthenticated context signs up as workspace B and tries
    // to open workspace A's conversation directly.
    const otherPage = await context.browser()!.newContext().then((c) => c.newPage());
    await otherPage.goto("/signup");
    await otherPage.getByLabel("Email").fill(EMAIL_B);
    await otherPage.getByLabel("Password").fill(PASSWORD);
    await otherPage.getByRole("button", { name: "Create account" }).click();
    await expect(otherPage).toHaveURL(/\/studio$/, { timeout: 10_000 });

    const response = await otherPage.goto(`/studio/c/${sessionId}`);
    expect(response?.status()).toBe(404);
    await otherPage.close();
  });
});
