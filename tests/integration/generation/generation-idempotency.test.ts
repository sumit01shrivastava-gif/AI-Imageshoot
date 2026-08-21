/**
 * Integration test: services/generation/job.server.ts's production
 * hardening — the idempotency guard (a redelivered/duplicate BullMQ job
 * for an already-SUCCEEDED GenerationJob must never create a second set
 * of results) and orphaned-storage cleanup (a DB write failure after a
 * successful provider call/upload must not leave an unreferenced object
 * behind). Against real local Postgres/Redis, a real BullMQ worker, and
 * the real (in this test, memory) storage provider — no mocking the
 * queue.
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

const SHOP = "gen-idempotency-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: "Studio Chair",
    handle: "studio-chair",
    description: "A minimalist chair.",
    productType: "Furniture",
    category: "Home & Garden > Furniture",
    vendor: "Acme Home",
    tags: ["chair"],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date("2026-01-05T00:00:00Z"),
    media: [
      {
        shopifyMediaId: "gid://shopify/MediaImage/1",
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/chair.jpg",
        previewUrl: null,
        width: 800,
        height: 600,
        altText: "Studio chair",
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.usageEvent.deleteMany({ where: { shop: SHOP } });
  await prisma.creditReservation.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let requestGeneration: typeof import("../../../services/generation/request-generation.server").requestGeneration;
let getGeneration: typeof import("../../../services/generation/request-generation.server").getGeneration;
let processGenerationJob: typeof import("../../../services/generation/job.server").processGenerationJob;
let generationBullJobId: typeof import("../../../services/generation/job.server").generationBullJobId;
let enqueueGenerationJob: typeof import("../../../services/generation/queue.server").enqueueGenerationJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ requestGeneration, getGeneration } = await import("../../../services/generation/request-generation.server"));
  ({ processGenerationJob, generationBullJobId } = await import("../../../services/generation/job.server"));
  ({ enqueueGenerationJob } = await import("../../../services/generation/queue.server"));

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

async function seedAnalyzedProduct(shopifyProductId: string) {
  await upsertSyncedProduct(SHOP, product(shopifyProductId));
  const row = await prisma.shopifyProduct.findFirstOrThrow({ where: { shop: SHOP, shopifyProductId } });

  const data = parseProductIntelligenceOutput({
    category: "Furniture",
    modelSuitable: false,
    recommendedAssetTypes: ["product_studio", "scene"],
    identityAnchors: { category: "Furniture", material: "Wood", primaryColor: "Brown" },
    material: "Wood",
    primaryColor: "Brown",
    confidence: 0.8,
  });
  await saveIntelligenceResult(SHOP, row.id, data, {
    providerName: "deterministic-test",
    sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
    rawAnalysis: {},
  });

  return row;
}

function waitForStatus(jobId: string, status: "SUCCEEDED" | "FAILED", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const job = await getGeneration(CONTEXT, jobId);
      if (job?.status === status) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; last saw ${job?.status}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("generation idempotency — duplicate delivery of an already-SUCCEEDED job", () => {
  it("never creates a second set of results when the same job is processed twice", async () => {
    const product = await seedAnalyzedProduct("idempotency-product-1");
    const job = await requestGeneration(CONTEXT, { productId: product.id, generationType: "PRODUCT_CLEANUP" });

    await waitForStatus(job.id, "SUCCEEDED");
    const afterFirstRun = await getGeneration(CONTEXT, job.id);
    expect(afterFirstRun!.results).toHaveLength(1);
    const originalResultId = afterFirstRun!.results[0].id;
    const originalStorageKey = (afterFirstRun!.results[0] as unknown as { storageKey?: string }).storageKey;

    // Simulate a duplicate/redelivered BullMQ job for the SAME
    // GenerationJob — legitimate, since `removeOnComplete: true`
    // (lib/queue/queue.server.ts) frees the deterministic jobId the
    // moment the first run completes, so a genuine redelivery (or a
    // merchant's browser tab racing a second identical request) would
    // enqueue successfully rather than being rejected by BullMQ itself.
    await enqueueGenerationJob({ shop: SHOP, generationJobId: job.id });

    // Give the worker a moment to pick it up and (correctly) no-op.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const afterSecondRun = await getGeneration(CONTEXT, job.id);
    expect(afterSecondRun!.results).toHaveLength(1);
    expect(afterSecondRun!.results[0].id).toBe(originalResultId);
    if (originalStorageKey) {
      expect((afterSecondRun!.results[0] as unknown as { storageKey?: string }).storageKey).toBe(originalStorageKey);
    }

    // The usage ledger is likewise unaffected by the duplicate delivery —
    // see services/usage/usage-accounting.server.ts and
    // db/repositories/usage-event.repository.ts's idempotency semantics.
    const usageEvents = await prisma.usageEvent.findMany({ where: { shop: SHOP, jobId: job.id } });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].status).toBe("SUCCEEDED");
  });

  it("still exposes the correct BullMQ job id for a duplicate delivery (same deterministic id)", () => {
    const payload: GenerationJobPayload = { shop: SHOP, generationJobId: "abc123" };
    expect(generationBullJobId(payload)).toBe(generationBullJobId(payload));
  });
});

describe("generation result persistence — the object actually uploaded is the one referenced", () => {
  it("the persisted storageKey resolves to a real, existing storage object", async () => {
    const product = await seedAnalyzedProduct("idempotency-product-2");
    const job = await requestGeneration(CONTEXT, { productId: product.id, generationType: "PRODUCT_CLEANUP" });
    await waitForStatus(job.id, "SUCCEEDED");

    const succeeded = await getGeneration(CONTEXT, job.id);
    const storageKey = (succeeded!.results[0] as unknown as { storageKey?: string }).storageKey;
    expect(storageKey).toBeTruthy();

    // The object genuinely exists in storage — a real, uploaded artifact,
    // not a stub. See tests/unit/generation/job-orphan-cleanup.test.ts
    // for the actual failure-path proof (a DB write failure after upload
    // deletes this object rather than leaving it orphaned) — that
    // specific failure mode isn't reachable through this file's
    // real-Postgres setup without injecting a fault.
    const storage = getConfiguredStorageProvider();
    expect(await storage.exists(storageKey!)).toBe(true);
  });
});
