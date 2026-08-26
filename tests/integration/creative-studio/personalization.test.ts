/**
 * Integration test: services/creative-studio/session.server.ts's
 * personalization WIRING (services/creative-studio/personalization.server.ts),
 * now backed by the REAL, production `PrismaCreativeProfileStore` (real
 * local Postgres/Redis, a real "generation" BullMQ worker, the
 * deterministic test image-generation provider — never a live vendor
 * call). Standalone (no Shopify product) sessions only — personalization
 * is inert for a Shopify-context session (no `userId` concept there; see
 * personalization.server.ts's module doc comment), which is exactly
 * what one test in this file proves directly.
 *
 * Every test here goes through `getConfiguredCreativeProfileStore()`'s
 * REAL resolved default (no `setConfiguredCreativeProfileStoreForTests`
 * override anywhere in this file) — see
 * tests/unit/creative-studio/personalization.test.ts for the fast,
 * DB-free algorithm tests that DO inject the in-memory implementation.
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
import {
  resetConfiguredCreativeProfileStoreForTests,
  applyLearnedDefaults,
} from "../../../services/creative-studio/personalization.server";
import { parseParsedIntent } from "../../../services/creative-studio/intent-schema";
import type { AuthContext } from "../../../lib/auth/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP = "workspace:personalization-test";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };
const EMAIL_A = "personalization-test-user-a@example.test";
const EMAIL_B = "personalization-test-user-b@example.test";
// Real `User` rows, not arbitrary strings — `CreativePreferenceObservation
// .userId` is a genuine foreign key (see prisma/schema.prisma), correctly
// enforced even in this test: production `userId`s always come from
// `requireWorkspaceContext` resolving a real signed-in user, so a
// synthetic id here would silently fail every write (the exact real bug
// this fixed-up test setup catches — see this file's own history).
let USER_A: string;
let USER_B: string;

function freshIntent() {
  return parseParsedIntent({ intent: "CREATE_LIFESTYLE", mode: "TEXT_TO_IMAGE", changeSummary: "test" });
}

async function cleanup() {
  await prisma.creativeMessage.deleteMany({ where: { shop: SHOP } });
  await prisma.creativeSession.deleteMany({ where: { shop: SHOP } });
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
  await prisma.generationJob.deleteMany({ where: { shop: SHOP } });
  await prisma.usageEvent.deleteMany({ where: { shop: SHOP } });
  if (USER_A && USER_B) {
    await prisma.creativePreferenceObservation.deleteMany({ where: { userId: { in: [USER_A, USER_B] } } });
  }
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

  await prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
  const [userA, userB] = await Promise.all([
    prisma.user.create({ data: { email: EMAIL_A, passwordHash: "not-a-real-hash-test-only" } }),
    prisma.user.create({ data: { email: EMAIL_B, passwordHash: "not-a-real-hash-test-only" } }),
  ]);
  USER_A = userA.id;
  USER_B = userB.id;

  await cleanup();
});

afterEach(async () => {
  await cleanup();
  resetConfiguredCreativeProfileStoreForTests();
});

afterAll(async () => {
  await worker?.close();
  await cleanup();
  await prisma.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B] } } });
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

describe("personalization — real PostgreSQL persistence (proves this survives a process boundary, not just in-memory state)", () => {
  it("a preference recorded through one call site is visible after resetting the store resolver — simulating a fresh process (e.g. Railway) reading what Vercel wrote", async () => {
    const { id: sessionId } = await session.startCreativeSession(CONTEXT, {});
    for (let i = 0; i < 3; i++) {
      const result = await session.sendCreativeMessage(CONTEXT, sessionId, "Create a product photo with warm lighting", {
        userId: USER_A,
      });
      await waitForJob(result.generationJobId);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: result.generationJobId }, select: { results: { select: { id: true } } } });
      await session.reviewCreativeResult(CONTEXT, job.results[0].id, "APPROVED", USER_A);
    }

    // Discard whatever store instance the resolver currently holds and
    // force it to build a brand new one — the ONLY way this can still
    // see User A's preference is if it was genuinely written to
    // PostgreSQL rather than held in that discarded instance's own
    // process memory.
    resetConfiguredCreativeProfileStoreForTests();

    const result = await applyLearnedDefaults(USER_A, freshIntent());
    expect(result.lighting).toBe("warm lighting");

    // Confirm directly against the table too, not just through the
    // module's own read path.
    const rows = await prisma.creativePreferenceObservation.findMany({ where: { userId: USER_A, field: "lighting" } });
    expect(rows.find((r) => r.value === "warm lighting")?.sampleCount).toBeGreaterThanOrEqual(3);
  }, 20000);

  it("a preference not reinforced in a long time decays below a freshly-reinforced competing value for the same field", async () => {
    // freshIntent() uses CREATE_LIFESTYLE -> the "campaign" context bucket
    // (see personalization.server.ts's contextForIntent) — both seeded
    // rows below must be in that same bucket for applyLearnedDefaults to
    // ever see them.
    // "warm lighting" observed heavily, but a long time ago.
    await prisma.creativePreferenceObservation.create({
      data: {
        userId: USER_A,
        field: "lighting",
        value: "warm lighting",
        context: "campaign",
        positiveWeight: 10,
        negativeWeight: 0,
        sampleCount: 10,
        lastObservedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago (3 half-lives)
      },
    });
    // "dim lighting" observed just now, far fewer times.
    for (let i = 0; i < 3; i++) {
      await prisma.creativePreferenceObservation.upsert({
        where: { userId_field_value_context: { userId: USER_A, field: "lighting", value: "dim lighting", context: "campaign" } },
        create: { userId: USER_A, field: "lighting", value: "dim lighting", context: "campaign", positiveWeight: 0.6, negativeWeight: 0, sampleCount: 1 },
        update: { positiveWeight: { increment: 0.6 }, sampleCount: { increment: 1 }, lastObservedAt: new Date() },
      });
    }

    const result = await applyLearnedDefaults(USER_A, freshIntent());
    // 10 raw observations decayed by 90 days (0.5^3 = 0.125) -> decayed
    // weight 1.25 (below the 1.5 threshold entirely); 3 fresh
    // observations -> decayed weight 1.8 (clears it). The fresher,
    // less-historically-observed value wins.
    expect(result.lighting).toBe("dim lighting");
  }, 20000);

  it("a preference learned in one context never leaks into another context for the same user (real Postgres rows)", async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.creativePreferenceObservation.upsert({
        where: { userId_field_value_context: { userId: USER_A, field: "lighting", value: "dark and moody", context: "campaign" } },
        create: { userId: USER_A, field: "lighting", value: "dark and moody", context: "campaign", positiveWeight: 1, negativeWeight: 0, sampleCount: 1 },
        update: { positiveWeight: { increment: 1 }, sampleCount: { increment: 1 }, lastObservedAt: new Date() },
      });
    }

    const catalogResult = await applyLearnedDefaults(USER_A, parseParsedIntent({ intent: "CREATE_MARKETPLACE", mode: "TEXT_TO_IMAGE", changeSummary: "test" }));
    expect(catalogResult.lighting).toBeNull();

    const campaignResult = await applyLearnedDefaults(USER_A, freshIntent());
    expect(campaignResult.lighting).toBe("dark and moody");
  }, 20000);
});
