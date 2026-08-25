/**
 * Integration tests for the standalone (non-Shopify) studio surface —
 * signup/login/logout, workspace authentication, and the new
 * conversational routes (app/routes/studio.tsx, studio._index.tsx,
 * studio.c.$sessionId.tsx, studio.creations.tsx) built this phase on top
 * of the EXISTING services/creative-studio/session.server.ts pipeline —
 * no second generation engine. Runs a real "generation" BullMQ worker so
 * "send a message" reaches the real queue, mirroring
 * tests/integration/routes/app.creative-session-route.test.ts's
 * established pattern for the Shopify-embedded route.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { resetConfiguredStorageProviderForTests, getConfiguredStorageProvider } from "../../../lib/storage";
import { signUp } from "../../../services/workspace/signup.server";
import { createUserSession, destroyUserSession } from "../../../lib/auth/standalone-session.server";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const EMAIL_A = "studio-routes-a@example.com";
const EMAIL_B = "studio-routes-b@example.com";
const PASSWORD = "correct-horse-battery-staple";

/** Extracts just the `name=value` pair from a `Set-Cookie` header value —
 * the shape a request's own `Cookie` header needs (no `Path=`/`HttpOnly`/
 * etc. attributes, which only belong on the response side). */
function cookieHeaderFrom(setCookie: string): string {
  return setCookie.split(";")[0];
}

async function signUpAndGetCookie(email: string): Promise<{ userId: string; cookie: string }> {
  const { user } = await signUp(email, PASSWORD);
  const { setCookie } = await createUserSession(user.id);
  return { userId: user.id, cookie: cookieHeaderFrom(setCookie) };
}

async function tenantKeyForUser(userId: string): Promise<string> {
  const membership = await prisma.workspaceMembership.findFirstOrThrow({ where: { userId }, include: { workspace: true } });
  return membership.workspace.tenantKey;
}

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

let worker: Worker | undefined;
let studioLayoutLoader: typeof import("../../../app/routes/studio").loader;
let newConversationAction: typeof import("../../../app/routes/studio._index").action;
let newConversationLoader: typeof import("../../../app/routes/studio._index").loader;
let conversationLoader: typeof import("../../../app/routes/studio.c.$sessionId").loader;
let conversationAction: typeof import("../../../app/routes/studio.c.$sessionId").action;
let creationsLoader: typeof import("../../../app/routes/studio.creations").loader;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ loader: studioLayoutLoader } = await import("../../../app/routes/studio"));
  ({ action: newConversationAction, loader: newConversationLoader } = await import("../../../app/routes/studio._index"));
  ({ loader: conversationLoader, action: conversationAction } = await import("../../../app/routes/studio.c.$sessionId"));
  ({ loader: creationsLoader } = await import("../../../app/routes/studio.creations"));

  const { processGenerationJob } = await import("../../../services/generation/job.server");
  worker = createWorker<GenerationJobPayload>("generation", processGenerationJob);
  await new Promise<void>((resolve) => worker!.on("ready", () => resolve()));

  await cleanup();
});

afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});

afterAll(async () => {
  await cleanup();
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

function requestWithCookie(url: string, cookie?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  return new Request(url, { ...init, headers });
}

async function callStudioLayoutLoader(cookie?: string) {
  return studioLayoutLoader({
    request: requestWithCookie("https://example.com/studio", cookie),
    params: {},
    context: {},
  } as unknown as Parameters<typeof studioLayoutLoader>[0]);
}

async function callNewConversationAction(cookie: string, formData: FormData) {
  return newConversationAction({
    request: requestWithCookie("https://example.com/studio", cookie, { method: "POST", body: formData }),
    params: {},
    context: {},
  } as unknown as Parameters<typeof newConversationAction>[0]);
}

async function callConversationLoader(cookie: string, sessionId: string) {
  return conversationLoader({
    request: requestWithCookie(`https://example.com/studio/c/${sessionId}`, cookie),
    params: { sessionId },
    context: {},
  } as unknown as Parameters<typeof conversationLoader>[0]);
}

async function callConversationAction(cookie: string, sessionId: string, formData: FormData) {
  return conversationAction({
    request: requestWithCookie(`https://example.com/studio/c/${sessionId}`, cookie, { method: "POST", body: formData }),
    params: { sessionId },
    context: {},
  } as unknown as Parameters<typeof conversationAction>[0]);
}

async function callCreationsLoader(cookie: string) {
  return creationsLoader({
    request: requestWithCookie("https://example.com/studio/creations", cookie),
    params: {},
    context: {},
  } as unknown as Parameters<typeof creationsLoader>[0]);
}

function waitForJobStatus(cookie: string, sessionId: string, status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const detail = await callConversationLoader(cookie, sessionId);
      if (detail.jobs[0]?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${detail.jobs[0]?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("standalone authentication", () => {
  it("1. redirects an unauthenticated request to /login", async () => {
    await expect(callStudioLayoutLoader()).rejects.toMatchObject({ status: 302 });
    try {
      await callStudioLayoutLoader();
    } catch (response) {
      expect((response as Response).headers.get("Location")).toBe("/login");
    }
  });

  it("2. lets an authenticated user open /studio", async () => {
    const { cookie } = await signUpAndGetCookie(EMAIL_A);
    const data = await callStudioLayoutLoader(cookie);
    expect(data.email).toBe(EMAIL_A);
    expect(data.workspaceName).toBeTruthy();
    expect(data.conversations).toEqual([]);
  });

  it("17. logout invalidates the session — a subsequent request is unauthenticated again", async () => {
    const { cookie } = await signUpAndGetCookie(EMAIL_A);
    await callStudioLayoutLoader(cookie); // sanity: works before logout

    const request = requestWithCookie("https://example.com/logout", cookie, { method: "POST" });
    await destroyUserSession(request);

    await expect(callStudioLayoutLoader(cookie)).rejects.toMatchObject({ status: 302 });
  });
});

describe("3–11. new conversation → real generation → conversation view", () => {
  it(
    "3+4. a text-only prompt creates a real, product-less CreativeSession and GenerationJob, reaches the queue, and produces a result",
    async () => {
      const { cookie } = await signUpAndGetCookie(EMAIL_A);
      const shop = await tenantKeyForUser((await prisma.user.findUniqueOrThrow({ where: { email: EMAIL_A } })).id);

      const formData = new FormData();
      formData.set("message", "Create a clean product photo on a white background");
      const result = await callNewConversationAction(cookie, formData);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
      const location = (result as Response).headers.get("Location")!;
      expect(location).toMatch(/^\/studio\/c\//);
      const sessionId = location.replace("/studio/c/", "");

      const sessionRow = await prisma.creativeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(sessionRow.productId).toBeNull();
      expect(sessionRow.shop).toBe(shop);

      const job = await prisma.generationJob.findFirstOrThrow({ where: { shop, creativeSessionId: sessionId } });
      expect(job.productId).toBeNull();

      await waitForJobStatus(cookie, sessionId, "SUCCEEDED");
      const detail = await callConversationLoader(cookie, sessionId);
      expect(detail.jobs[0].results.length).toBeGreaterThan(0);
    },
    15000,
  );

  it(
    "5+6. an uploaded image reaches the generation system as a reference and the job is created/processed by the worker",
    async () => {
      const { cookie } = await signUpAndGetCookie(EMAIL_A);

      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const file = new File([bytes], "sneaker.png", { type: "image/png" });

      const formData = new FormData();
      formData.set("message", "Create a studio product shot from this photo");
      formData.append("images", file);
      const result = await callNewConversationAction(cookie, formData);
      const sessionId = (result as Response).headers.get("Location")!.replace("/studio/c/", "");

      const job = await prisma.generationJob.findFirstOrThrow({ where: { creativeSessionId: sessionId } });
      const plan = job.plan as unknown as { referenceImages: Array<{ url: string; role: string }> };
      expect(plan.referenceImages).toHaveLength(1);
      const storageKey = decodeURIComponent(plan.referenceImages[0].url.split("?")[0].replace(/^\/media\//, ""));
      expect(await getConfiguredStorageProvider().exists(storageKey)).toBe(true);

      await waitForJobStatus(cookie, sessionId, "SUCCEEDED");
    },
    15000,
  );

  it(
    "9+10+11. a follow-up message creates a NEW GenerationJob without destroying the previous one — every version stays accessible",
    async () => {
      const { cookie } = await signUpAndGetCookie(EMAIL_A);
      const formData = new FormData();
      formData.set("message", "Create a clean product photo");
      const result = await callNewConversationAction(cookie, formData);
      const sessionId = (result as Response).headers.get("Location")!.replace("/studio/c/", "");
      await waitForJobStatus(cookie, sessionId, "SUCCEEDED");

      const followUp = new FormData();
      followUp.set("intent", "send-message");
      followUp.set("message", "Make the background darker");
      const followUpResult = (await callConversationAction(cookie, sessionId, followUp)) as { ok: boolean; generationJobId?: string };
      expect(followUpResult.ok).toBe(true);
      await waitForJobStatus(cookie, sessionId, "SUCCEEDED");

      const detail = await callConversationLoader(cookie, sessionId);
      expect(detail.jobs).toHaveLength(2);
      expect(detail.jobs.every((job) => job.results.length > 0)).toBe(true);
      expect(detail.messages).toHaveLength(4);
    },
    20000,
  );

  it(
    "14+15+16. a conversation appears in /studio's history sidebar and /studio/creations, and reopens exactly where it left off",
    async () => {
      const { cookie } = await signUpAndGetCookie(EMAIL_A);
      const formData = new FormData();
      formData.set("message", "Create a luxury campaign shot");
      const result = await callNewConversationAction(cookie, formData);
      const sessionId = (result as Response).headers.get("Location")!.replace("/studio/c/", "");
      await waitForJobStatus(cookie, sessionId, "SUCCEEDED");

      const layout = await callStudioLayoutLoader(cookie);
      expect(layout.conversations.some((c) => c.id === sessionId)).toBe(true);
      expect(layout.conversations.find((c) => c.id === sessionId)?.title).toContain("Luxury campaign");

      const creations = await callCreationsLoader(cookie);
      expect(creations.conversations.some((c) => c.id === sessionId)).toBe(true);

      // Reopening loads the SAME session with its existing message/result
      // history intact — not a fresh/empty conversation.
      const reopened = await callConversationLoader(cookie, sessionId);
      expect(reopened.session.id).toBe(sessionId);
      expect(reopened.messages.length).toBeGreaterThan(0);
      expect(reopened.jobs.length).toBeGreaterThan(0);
    },
    15000,
  );
});

describe("21. tenant isolation between workspaces", () => {
  it("a second workspace can never load the first workspace's conversation", async () => {
    const { cookie: cookieA } = await signUpAndGetCookie(EMAIL_A);
    const formData = new FormData();
    formData.set("message", "Create a clean product photo");
    const result = await callNewConversationAction(cookieA, formData);
    const sessionId = (result as Response).headers.get("Location")!.replace("/studio/c/", "");

    const { cookie: cookieB } = await signUpAndGetCookie(EMAIL_B);
    await expect(callConversationLoader(cookieB, sessionId)).rejects.toMatchObject({ status: 404 });

    const followUp = new FormData();
    followUp.set("intent", "send-message");
    followUp.set("message", "Make it darker");
    await expect(callConversationAction(cookieB, sessionId, followUp)).rejects.toMatchObject({ status: 404 });
  });

  it("/studio/creations and the sidebar never list another workspace's conversations", async () => {
    const { cookie: cookieA } = await signUpAndGetCookie(EMAIL_A);
    const formData = new FormData();
    formData.set("message", "Create a clean product photo");
    await callNewConversationAction(cookieA, formData);

    const { cookie: cookieB } = await signUpAndGetCookie(EMAIL_B);
    const creationsB = await callCreationsLoader(cookieB);
    expect(creationsB.conversations).toEqual([]);
    const layoutB = await callStudioLayoutLoader(cookieB);
    expect(layoutB.conversations).toEqual([]);
  });
});

describe("new-conversation composer validation", () => {
  it("rejects an empty submission (no message, no image) with a clear error, never a crash", async () => {
    const { cookie } = await signUpAndGetCookie(EMAIL_A);
    const formData = new FormData();
    formData.set("message", "");
    const result = await callNewConversationAction(cookie, formData);
    expect(result).toMatchObject({ ok: false });
  });

  it("the landing loader itself just requires authentication, no other precondition", async () => {
    const { cookie } = await signUpAndGetCookie(EMAIL_A);
    await expect(newConversationLoader({ request: requestWithCookie("https://example.com/studio", cookie), params: {}, context: {} } as unknown as Parameters<typeof newConversationLoader>[0])).resolves.toBeNull();
  });

  it("never leaves an empty, cluttering session behind when the first message fails (e.g. insufficient credits)", async () => {
    const { cookie } = await signUpAndGetCookie(EMAIL_A);
    process.env.CREATIVE_STUDIO_MONTHLY_CREDITS = "0";
    resetEnvCacheForTests();
    try {
      const formData = new FormData();
      formData.set("message", "Create a clean product photo");
      const result = await callNewConversationAction(cookie, formData);
      expect(result).toMatchObject({ ok: false });

      const shop = await tenantKeyForUser((await prisma.user.findUniqueOrThrow({ where: { email: EMAIL_A } })).id);
      const sessions = await prisma.creativeSession.findMany({ where: { shop } });
      expect(sessions).toHaveLength(0);
    } finally {
      delete process.env.CREATIVE_STUDIO_MONTHLY_CREDITS;
      resetEnvCacheForTests();
    }
  });
});

describe("multiple conversations", () => {
  it(
    "a second 'New conversation' does not destroy the first — both remain independently accessible",
    async () => {
      const { cookie } = await signUpAndGetCookie(EMAIL_A);

      const first = new FormData();
      first.set("message", "Create a clean studio shot");
      const firstResult = await callNewConversationAction(cookie, first);
      const firstId = (firstResult as Response).headers.get("Location")!.replace("/studio/c/", "");
      await waitForJobStatus(cookie, firstId, "SUCCEEDED");

      const second = new FormData();
      second.set("message", "Create a lifestyle campaign scene");
      const secondResult = await callNewConversationAction(cookie, second);
      const secondId = (secondResult as Response).headers.get("Location")!.replace("/studio/c/", "");
      expect(secondId).not.toBe(firstId);
      await waitForJobStatus(cookie, secondId, "SUCCEEDED");

      // Both conversations, independently, still have their own full
      // history — switching to the second never lost the first.
      const firstDetail = await callConversationLoader(cookie, firstId);
      const secondDetail = await callConversationLoader(cookie, secondId);
      expect(firstDetail.messages.length).toBeGreaterThan(0);
      expect(secondDetail.messages.length).toBeGreaterThan(0);
      expect(firstDetail.session.id).toBe(firstId);
      expect(secondDetail.session.id).toBe(secondId);

      const layout = await callStudioLayoutLoader(cookie);
      const ids = layout.conversations.map((c) => c.id);
      expect(ids).toContain(firstId);
      expect(ids).toContain(secondId);
    },
    20000,
  );
});
