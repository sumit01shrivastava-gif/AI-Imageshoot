/**
 * Integration test: services/creative-studio/session.server.ts, end to
 * end — real local Postgres/Redis, a real `"generation"` BullMQ worker,
 * and the deterministic test image-generation provider (never a live
 * vendor call — see CLAUDE.md). Covers session creation, tenant
 * isolation, conversation persistence, a real generation request
 * reaching the real queue, multiple results/variations, regeneration,
 * credit reserve/settle/refund (including a forced failure), storage
 * persistence, and previous-result preservation across turns.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP = "creative-studio-session-test.myshopify.com";
const OTHER_SHOP = "creative-studio-session-other.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };
const OTHER_CONTEXT: AuthContext = { shop: OTHER_SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Studio Tote",
    handle: "studio-tote",
    description: "A handcrafted leather tote.",
    productType: "Handbags",
    category: "Handbags",
    vendor: "Acme",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: `${shopifyProductId}-media-1`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/tote.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio tote",
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.creativeMessage.deleteMany({ where: { shop } });
    await prisma.creativeSession.deleteMany({ where: { shop } });
    await prisma.creditReservation.deleteMany({ where: { shop } });
    await prisma.generationJob.deleteMany({ where: { shop } });
    await prisma.shopifyProduct.deleteMany({ where: { shop } });
    await prisma.usageEvent.deleteMany({ where: { shop } });
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

  await cleanup();

  // Several tests below request more than one output (MULTI_VARIATION,
  // multi-image regeneration) — the FREE plan's maxOutputsPerGeneration
  // is 1 (see services/billing/plans.ts), so this suite needs a real
  // plan that allows more, same as every other domain's identical
  // pattern (see tests/integration/store-visuals/store-visual-queue.test.ts).
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.shopSubscription.upsert({
      where: { shop },
      create: { shop, planId: "STARTER", status: "ACTIVE" },
      update: { planId: "STARTER", status: "ACTIVE" },
    });
  }
});

afterEach(async () => {
  await cleanup();
  resetConfiguredStorageProviderForTests();
});

afterAll(async () => {
  await cleanup();
  await prisma.shopSubscription.deleteMany({ where: { shop: { in: [SHOP, OTHER_SHOP] } } });
  await worker?.close();
  await closeRedisConnection();
  await prisma.$disconnect();
  delete process.env.AI_PROVIDER;
});

async function seedAnalyzedProduct(shop: string, shopifyProductId: string) {
  await upsertSyncedProduct(shop, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop, shopifyProductId } });

  const data = parseProductIntelligenceOutput({
    category: "Handbags",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio", "lifestyle"],
    identityAnchors: {
      category: "Handbags",
      shape: "Rectangular",
      material: "Leather",
      primaryColor: "Brown",
      distinctiveHardware: ["gold clasp"],
    },
    material: "Leather",
    primaryColor: "Brown",
  });
  await saveIntelligenceResult(shop, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });

  return row;
}

function waitForJobStatus(
  context: AuthContext,
  sessionId: string,
  status: "SUCCEEDED" | "FAILED",
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const detail = await session.getCreativeSessionDetail(context, sessionId);
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

describe("startCreativeSession", () => {
  it("creates a session for an owned product", async () => {
    const row = await seedAnalyzedProduct(SHOP, "session-product-1");
    const created = await session.startCreativeSession(CONTEXT, { productId: row.id });
    expect(created.id).toBeTruthy();

    const detail = await session.getCreativeSessionDetail(CONTEXT, created.id);
    expect(detail.session.productId).toBe(row.id);
    expect(detail.session.status).toBe("ACTIVE");
    expect(detail.session.sourceType).toBe("PRODUCT_IMAGE");
    expect(detail.messages).toEqual([]);
    expect(detail.jobs).toEqual([]);
  });

  it("throws ProductNotFoundError for another shop's product (tenant isolation)", async () => {
    const otherRow = await seedAnalyzedProduct(OTHER_SHOP, "session-product-cross-1");
    await expect(session.startCreativeSession(CONTEXT, { productId: otherRow.id })).rejects.toThrow(session.ProductNotFoundError);
  });
});

describe("tenant isolation", () => {
  it("never lets a shop load another shop's session", async () => {
    const otherRow = await seedAnalyzedProduct(OTHER_SHOP, "session-product-cross-2");
    const otherSession = await session.startCreativeSession(OTHER_CONTEXT, { productId: otherRow.id });

    await expect(session.getCreativeSessionDetail(CONTEXT, otherSession.id)).rejects.toThrow();
  });

  it("never lets a shop send a message into another shop's session", async () => {
    const otherRow = await seedAnalyzedProduct(OTHER_SHOP, "session-product-cross-3");
    const otherSession = await session.startCreativeSession(OTHER_CONTEXT, { productId: otherRow.id });

    await expect(session.sendCreativeMessage(CONTEXT, otherSession.id, "Make it brighter")).rejects.toThrow();
  });
});

describe("sendCreativeMessage — conversation persistence and real generation", () => {
  it(
    "persists the USER and ASSISTANT messages, reaches the real queue, and produces a SUCCEEDED result the session then treats as current",
    async () => {
      const row = await seedAnalyzedProduct(SHOP, "session-product-2");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });

      const sent = await session.sendCreativeMessage(CONTEXT, created.id, "Put my product in a premium lifestyle scene");
      expect(sent.ok).toBe(true);
      expect(sent.parsedIntent.intent).toBe("CREATE_LIFESTYLE");

      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const detail = await session.getCreativeSessionDetail(CONTEXT, created.id);
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages[0].role).toBe("USER");
      expect(detail.messages[0].content).toBe("Put my product in a premium lifestyle scene");
      expect(detail.messages[0].intent).toBeTruthy();
      expect(detail.messages[1].role).toBe("ASSISTANT");

      expect(detail.jobs).toHaveLength(1);
      expect(detail.jobs[0].type).toBe("CREATIVE_STUDIO");
      expect(detail.jobs[0].results).toHaveLength(1);

      // The first successful result automatically becomes the session's
      // current working image (see services/generation/job.server.ts's
      // setInitialCreativeSessionResult) — no extra "select" step needed
      // for the natural single-image flow.
      const refreshed = await prisma.creativeSession.findUniqueOrThrow({ where: { id: created.id } });
      expect(refreshed.currentResultId).toBe(detail.jobs[0].results[0].id);

      // Original Shopify-hosted media is untouched.
      const media = await prisma.shopifyProductMedia.findFirstOrThrow({ where: { shop: SHOP, productId: row.id } });
      expect(media.originalUrl).toBe("https://cdn.shopify.com/tote.jpg");
    },
    15000,
  );

  it(
    "produces multiple independently-reviewable results for a MULTI_VARIATION request",
    async () => {
      const row = await seedAnalyzedProduct(SHOP, "session-product-3");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });

      const sent = await session.sendCreativeMessage(CONTEXT, created.id, "Create 3 variations");
      expect(sent.parsedIntent.variationCount).toBe(3);
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const detail = await session.getCreativeSessionDetail(CONTEXT, created.id);
      expect(detail.jobs[0].results).toHaveLength(3);
      // Every result independently reviewable — distinct ids.
      const ids = new Set(detail.jobs[0].results.map((r) => r.id));
      expect(ids.size).toBe(3);
    },
    15000,
  );

  it(
    "a follow-up message creates a NEW GenerationJob (never overwrites the previous one) and carries forward the active creative state",
    async () => {
      const row = await seedAnalyzedProduct(SHOP, "session-product-4");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });

      await session.sendCreativeMessage(CONTEXT, created.id, "Put my product in a luxury bathroom");
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");
      const firstJob = (await session.getCreativeSessionDetail(CONTEXT, created.id)).jobs[0];

      const secondSend = await session.sendCreativeMessage(CONTEXT, created.id, "Make it brighter");
      expect(secondSend.parsedIntent.mode).toBe("IMAGE_TO_IMAGE");
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const detail = await session.getCreativeSessionDetail(CONTEXT, created.id);
      // Newest first — the follow-up job is now [0], the original is
      // still present and untouched at [1] ("Product → Creative Session
      // → multiple instructions → multiple generated versions").
      expect(detail.jobs).toHaveLength(2);
      expect(detail.jobs[0].id).not.toBe(firstJob.id);
      expect(detail.jobs[1].id).toBe(firstJob.id);
      expect(detail.jobs[1].results).toHaveLength(1); // untouched

      // The follow-up's own plan recorded a reference to the prior
      // result — real image-to-image wiring, not a fresh, unrelated
      // generation.
      const plan = detail.jobs[0].plan as { referenceImages: Array<{ role: string }> };
      expect(plan.referenceImages).toHaveLength(1);
      expect(plan.referenceImages[0].role).toBe("previous_result");

      expect(detail.messages.filter((m) => m.role === "USER")).toHaveLength(2);
    },
    20000,
  );

  it(
    "'regenerate this' / 'give me another variation' both create a fresh VARIATION job without needing new descriptive text",
    async () => {
      const row = await seedAnalyzedProduct(SHOP, "session-product-5");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });
      await session.sendCreativeMessage(CONTEXT, created.id, "Put my product in a studio scene");
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const regenerated = await session.sendCreativeMessage(CONTEXT, created.id, "Give me another variation.");
      expect(regenerated.parsedIntent.mode).toBe("VARIATION");
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const detail = await session.getCreativeSessionDetail(CONTEXT, created.id);
      expect(detail.jobs).toHaveLength(2);
    },
    20000,
  );
});

describe("credit reservation lifecycle", () => {
  it(
    "reserves credits on submit and settles them once the generation succeeds",
    async () => {
      const row = await seedAnalyzedProduct(SHOP, "session-product-6");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });
      const sent = await session.sendCreativeMessage(CONTEXT, created.id, "Put my product in a studio scene");
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const reservation = await prisma.creditReservation.findUniqueOrThrow({ where: { jobId: sent.generationJobId } });
      expect(reservation.status).toBe("CONSUMED");
      // A fresh TEXT_TO_IMAGE, single-output request — see
      // services/usage/credit-costs.ts's documented per-mode rate table.
      expect(reservation.amount).toBe(2);
      expect(reservation.operationType).toBe("IMAGE_GENERATION");
    },
    15000,
  );

  it(
    "refunds the reservation when generation fails, so a failed request never permanently consumes credits",
    async () => {
      // Constructs a plan by hand with the deterministic provider's
      // forced-failure marker — services/creative-studio/plan-builder.ts
      // never sets negativeConstraints itself (no route exposes that),
      // so the only way to exercise the real FAILED path here is to
      // build the plan directly, exactly like
      // tests/integration/generation/generation-queue.test.ts's own
      // established pattern for testing failure/retry.
      const row = await seedAnalyzedProduct(SHOP, "session-product-7");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });

      const { parseGenerationPlan } = await import("../../../services/generation/schema");
      const { FORCE_FAILURE_ALWAYS } = await import("../../../services/generation/deterministic-test-provider.server");
      const { createAndEnqueueGenerationJob } = await import("../../../services/generation/request-generation.server");
      const { reserveGenerationCredits } = await import("../../../services/usage/entitlement.server");

      const plan = parseGenerationPlan({
        generationType: "CREATIVE_STUDIO",
        assetType: "lifestyle",
        category: "Handbags",
        sourceProductId: row.id,
        sourceImages: [{ mediaId: "media-1", url: "https://cdn.shopify.com/tote.jpg", altText: null, position: 0 }],
        productFacts: { identityAnchors: null },
        creativeDirection: { prompt: "A test.", negativeConstraints: [FORCE_FAILURE_ALWAYS], environment: null, lighting: null, composition: null },
        aspectRatio: "1:1",
        outputFormat: "png",
        quality: "standard",
        outputCount: 1,
        modelConfiguration: null,
        brandStyle: null,
        lifestyleScene: null,
        creativeIntent: {
          intent: "CREATE_LIFESTYLE",
          mode: "TEXT_TO_IMAGE",
          creative: { scene: null, style: [], lighting: null, composition: null, camera: null, colorDirection: null, addElements: [], removeElements: [] },
          identityConstraints: { immutable: [], instruction: "preserve it" },
          creativeSessionId: created.id,
          rawInstruction: "force failure",
        },
        referenceImages: [],
        constraints: [],
      });

      const job = await createAndEnqueueGenerationJob(CONTEXT, {
        productId: row.id,
        generationType: "CREATIVE_STUDIO",
        sourceMediaIds: ["media-1"],
        planOverride: plan,
        creativeSessionId: created.id,
        beforeEnqueue: async (jobId) => {
          await reserveGenerationCredits(CONTEXT, jobId, 1);
        },
      });

      await waitForJobStatus(CONTEXT, created.id, "FAILED");

      const reservation = await prisma.creditReservation.findUniqueOrThrow({ where: { jobId: job.id } });
      expect(reservation.status).toBe("REFUNDED");
    },
    20000,
  );

  it("checkGenerationEntitlement denies a request once the shop's monthly allowance is exhausted", async () => {
    process.env.CREATIVE_STUDIO_MONTHLY_CREDITS = "1";
    resetEnvCacheForTests();
    const { checkGenerationEntitlement, reserveGenerationCredits } = await import("../../../services/usage/entitlement.server");

    try {
      await reserveGenerationCredits(CONTEXT, "quota-test-job-1", 1);
      const check = await checkGenerationEntitlement(CONTEXT, 1);
      expect(check.allowed).toBe(false);
      expect(check.available).toBe(0);
    } finally {
      delete process.env.CREATIVE_STUDIO_MONTHLY_CREDITS;
      resetEnvCacheForTests();
    }
  });
});

describe("storage persistence", () => {
  it(
    "the persisted storageKey for a Creative Studio result resolves to a real, existing storage object",
    async () => {
      const row = await seedAnalyzedProduct(SHOP, "session-product-8");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });
      await session.sendCreativeMessage(CONTEXT, created.id, "Put my product in a studio scene");
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const jobRow = await prisma.generationJob.findFirstOrThrow({
        where: { shop: SHOP, creativeSessionId: created.id },
        include: { results: true },
      });
      const storageKey = jobRow.results[0].storageKey;
      expect(await getConfiguredStorageProvider().exists(storageKey)).toBe(true);
    },
    15000,
  );
});

describe("selectCreativeResult and reviewCreativeResult", () => {
  it(
    "'Use this' updates the session's current result, and Approve/Reject reuse the same review lifecycle every other generationType uses",
    async () => {
      const row = await seedAnalyzedProduct(SHOP, "session-product-9");
      const created = await session.startCreativeSession(CONTEXT, { productId: row.id });
      await session.sendCreativeMessage(CONTEXT, created.id, "Create 2 variations");
      await waitForJobStatus(CONTEXT, created.id, "SUCCEEDED");

      const detail = await session.getCreativeSessionDetail(CONTEXT, created.id);
      const secondResult = detail.jobs[0].results[1];

      await session.selectCreativeResult(CONTEXT, created.id, secondResult.id);
      const afterSelect = await prisma.creativeSession.findUniqueOrThrow({ where: { id: created.id } });
      expect(afterSelect.currentResultId).toBe(secondResult.id);

      await session.reviewCreativeResult(CONTEXT, secondResult.id, "APPROVED");
      const reviewed = await prisma.generationResult.findUniqueOrThrow({ where: { id: secondResult.id } });
      expect(reviewed.reviewStatus).toBe("APPROVED");
    },
    15000,
  );

  it("rejects selecting a result that doesn't belong to this session", async () => {
    const row = await seedAnalyzedProduct(SHOP, "session-product-10");
    const created = await session.startCreativeSession(CONTEXT, { productId: row.id });
    await expect(session.selectCreativeResult(CONTEXT, created.id, "not-a-real-result-id")).rejects.toThrow(
      session.GenerationResultNotFoundError,
    );
  });
});
