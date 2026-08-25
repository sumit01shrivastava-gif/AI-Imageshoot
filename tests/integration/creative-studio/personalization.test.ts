/**
 * Integration test: services/creative-studio/session.server.ts's
 * personalization WIRING (services/creative-studio/personalization.server.ts)
 * — real local Postgres/Redis, a real "generation" BullMQ worker, the
 * deterministic test image-generation provider (never a live vendor
 * call). Standalone (no Shopify product) sessions only — personalization
 * is inert for a Shopify-context session (no `userId` concept there; see
 * personalization.server.ts's module doc comment), which is exactly
 * what the last test in this file proves directly.
 *
 * Mirrors tests/integration/creative-studio/session.test.ts's own
 * harness pattern (real queue/worker, not mocked), scoped to a
 * standalone workspace shop instead of a Shopify one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import { resetConfiguredCreativeProfileStoreForTests } from "../../../services/creative-studio/personalization.server";
import type { AuthContext } from "../../../lib/auth/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP = "workspace:personalization-test";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };
const USER_A = "personalization-test-user-a";
const USER_B = "personalization-test-user-b";

async function cleanup() {
  await prisma.creativeMessage.deleteMany({ where: { shop: SHOP } });
  await prisma.creativeSession.deleteMany({ where: { shop: SHOP } });
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
  await prisma.generationJob.deleteMany({ where: { shop: SHOP } });
  await prisma.usageEvent.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let session: typeof import("../../../services/creative-studio/session.server");
let processGenerationJob: typeof import("../../../services/generation/job.server").processGenerationJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  session = await import("../../../services/creative-studio/session.server");
  ({ processGenerationJob } = await import("../../../services/generation/job.server"));

  worker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();
});

afterEach(async () => {
  await cleanup();
  resetConfiguredCreativeProfileStoreForTests();
});

afterAll(async () => {
  await worker?.close();
  await cleanup();
  resetConfiguredStorageProviderForTests();
  await closeRedisConnection();
});

async function waitForJob(jobId: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await prisma.generationJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (job?.status === "SUCCEEDED" || job?.status === "FAILED") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function creativeFieldsForJob(jobId: string) {
  const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId }, select: { plan: true } });
  return (job.plan as { creativeIntent: { creative: { lighting: string | null } } }).creativeIntent.creative;
}

describe("personalization — real end-to-end wiring through sendCreativeMessage", () => {
  it("a learned lighting preference (from repeated approvals) is applied as a default on a LATER turn that doesn't specify one", async () => {
    const { id: sessionId } = await session.startCreativeSession(CONTEXT, {});

    // Three turns explicitly requesting warm lighting, each
    // approved — enough to clear the application threshold.
    for (let i = 0; i < 3; i++) {
      const result = await session.sendCreativeMessage(CONTEXT, sessionId, "Create a product photo with warm lighting", {
        userId: USER_A,
      });
      await waitForJob(result.generationJobId);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: result.generationJobId }, select: { results: { select: { id: true } } } });
      await session.reviewCreativeResult(CONTEXT, job.results[0].id, "APPROVED", USER_A);
    }

    // A new, unrelated session for the SAME user — proves the learned
    // preference is scoped to the USER, not just carried forward within
    // one conversation's own activeLighting.
    const { id: freshSessionId } = await session.startCreativeSession(CONTEXT, {});
    const result = await session.sendCreativeMessage(CONTEXT, freshSessionId, "Create a photo of a ceramic mug", { userId: USER_A });
    await waitForJob(result.generationJobId);
    const creative = await creativeFieldsForJob(result.generationJobId);
    expect(creative.lighting).toBe("warm lighting");
  }, 20000);

  it("an explicit lighting instruction in the CURRENT message overrides the learned preference", async () => {
    const { id: sessionId } = await session.startCreativeSession(CONTEXT, {});
    for (let i = 0; i < 3; i++) {
      const result = await session.sendCreativeMessage(CONTEXT, sessionId, "Create a product photo with warm lighting", {
        userId: USER_A,
      });
      await waitForJob(result.generationJobId);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: result.generationJobId }, select: { results: { select: { id: true } } } });
      await session.reviewCreativeResult(CONTEXT, job.results[0].id, "APPROVED", USER_A);
    }

    const { id: freshSessionId } = await session.startCreativeSession(CONTEXT, {});
    const result = await session.sendCreativeMessage(CONTEXT, freshSessionId, "Create a photo of a mug with dim lighting", {
      userId: USER_A,
    });
    await waitForJob(result.generationJobId);
    const creative = await creativeFieldsForJob(result.generationJobId);
    expect(creative.lighting).toBe("dim lighting");
  }, 20000);

  it("User B never receives User A's learned preference", async () => {
    const { id: sessionId } = await session.startCreativeSession(CONTEXT, {});
    for (let i = 0; i < 3; i++) {
      const result = await session.sendCreativeMessage(CONTEXT, sessionId, "Create a product photo with warm lighting", {
        userId: USER_A,
      });
      await waitForJob(result.generationJobId);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: result.generationJobId }, select: { results: { select: { id: true } } } });
      await session.reviewCreativeResult(CONTEXT, job.results[0].id, "APPROVED", USER_A);
    }

    const { id: userBSessionId } = await session.startCreativeSession(CONTEXT, {});
    const result = await session.sendCreativeMessage(CONTEXT, userBSessionId, "Create a photo of a ceramic mug", { userId: USER_B });
    await waitForJob(result.generationJobId);
    const creative = await creativeFieldsForJob(result.generationJobId);
    expect(creative.lighting).toBeNull();
  }, 20000);

  it("without a userId (e.g. a Shopify-context call), personalization is completely inert — no learned default is ever applied", async () => {
    const { id: sessionId } = await session.startCreativeSession(CONTEXT, {});
    for (let i = 0; i < 3; i++) {
      const result = await session.sendCreativeMessage(CONTEXT, sessionId, "Create a product photo with warm lighting", {
        userId: USER_A,
      });
      await waitForJob(result.generationJobId);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: result.generationJobId }, select: { results: { select: { id: true } } } });
      await session.reviewCreativeResult(CONTEXT, job.results[0].id, "APPROVED", USER_A);
    }

    const { id: noUserSessionId } = await session.startCreativeSession(CONTEXT, {});
    // No `userId` in options at all — the exact shape app.creative.$sessionId.tsx's
    // Shopify-context call site uses.
    const result = await session.sendCreativeMessage(CONTEXT, noUserSessionId, "Create a photo of a ceramic mug");
    await waitForJob(result.generationJobId);
    const creative = await creativeFieldsForJob(result.generationJobId);
    expect(creative.lighting).toBeNull();
  }, 20000);
});
