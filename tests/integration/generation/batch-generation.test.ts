/**
 * Integration test: batch lifestyle generation end to end — Phase 1's
 * `ImageSelection` → `startBatchGeneration` → real BullMQ enqueue → real
 * `processGenerationJob` worker (deterministic provider) → real storage →
 * `getGenerationBatchSummary`'s computed progress. Against real local
 * Postgres/Redis. Mirrors tests/integration/processing/batch-processing.test.ts.
 *
 * Unlike Processing's batch test, this file's "one job failing to even be
 * CREATED must not abort the batch" case uses a REAL, non-racy trigger:
 * generation requires a READY Product Intelligence profile
 * (ProductNotAnalyzedError otherwise — see build-plan.ts), so a selection
 * that includes one never-analyzed product reliably reproduces the
 * skip-and-continue path without needing to simulate a race.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import prisma from "../../../db/client.server";
import { createWorker, closeRedisConnection } from "../../../lib/queue";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { resetConfiguredStorageProviderForTests } from "../../../lib/storage";
import { upsertSyncedProduct } from "../../../db/repositories/shopify-product.repository";
import { saveResult as saveIntelligenceResult } from "../../../db/repositories/product-intelligence.repository";
import { parseProductIntelligenceOutput } from "../../../services/intelligence/schema";
import { createImageSelection } from "../../../services/products/selection.server";
import type { SyncedProduct } from "../../../services/products/types";
import type { AuthContext } from "../../../lib/auth/types";
import type { GenerationJobPayload } from "../../../services/generation/job.server";

const SHOP = "batch-gen-e2e-test.myshopify.com";
const CONTEXT: AuthContext = { shop: SHOP, sessionId: "s1", isOnline: false };

function product(shopifyProductId: string): SyncedProduct {
  return {
    shopifyProductId,
    title: `Product ${shopifyProductId}`,
    handle: shopifyProductId,
    description: "",
    productType: "Handbags",
    category: null,
    vendor: "",
    tags: [],
    status: "ACTIVE",
    shopifyCreatedAt: new Date(),
    shopifyUpdatedAt: new Date(),
    media: [
      {
        shopifyMediaId: `${shopifyProductId}-media`,
        mediaType: "IMAGE",
        originalUrl: "https://cdn.shopify.com/x.jpg",
        previewUrl: null,
        width: 100,
        height: 100,
        altText: null,
        position: 0,
      },
    ],
  };
}

async function cleanup() {
  await prisma.shopifyProduct.deleteMany({ where: { shop: SHOP } });
  await prisma.generationBatch.deleteMany({ where: { shop: SHOP } });
}

let worker: Worker | undefined;
let startBatchGeneration: typeof import("../../../services/generation/batch.server").startBatchGeneration;
let getGenerationBatchSummary: typeof import("../../../services/generation/batch.server").getGenerationBatchSummary;
let processGenerationJob: typeof import("../../../services/generation/job.server").processGenerationJob;

beforeAll(async () => {
  process.env.AI_PROVIDER = "deterministic-test";
  resetEnvCacheForTests();

  ({ startBatchGeneration, getGenerationBatchSummary } = await import("../../../services/generation/batch.server"));
  ({ processGenerationJob } = await import("../../../services/generation/job.server"));

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

async function seedProduct(
  id: string,
  { analyzed = true, modelSuitable = false }: { analyzed?: boolean; modelSuitable?: boolean } = {},
) {
  await upsertSyncedProduct(SHOP, product(id));
  const row = await prisma.shopifyProduct.findFirstOrThrow({
    where: { shop: SHOP, shopifyProductId: id },
    include: { media: true },
  });

  if (analyzed) {
    const data = parseProductIntelligenceOutput({
      category: "Handbags",
      modelSuitable,
      recommendedAssetTypes: ["lifestyle"],
      recommendedPoseTypes: modelSuitable ? ["carried/worn detail"] : [],
      identityAnchors: { category: "Handbags", material: "Leather", primaryColor: "Brown" },
      material: "Leather",
      primaryColor: "Brown",
      confidence: 0.8,
    });
    await saveIntelligenceResult(SHOP, row.id, data, {
      providerName: "deterministic-test",
      sourceShopifyUpdatedAt: row.shopifyUpdatedAt,
      rawAnalysis: {},
    });
  }

  return row;
}

function waitForTerminal(batchId: string, expectedTotal: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<Awaited<ReturnType<typeof getGenerationBatchSummary>>>((resolve, reject) => {
    const poll = async () => {
      const summary = await getGenerationBatchSummary(CONTEXT, batchId);
      const { progress } = summary!;
      const inFlight = progress.pending + progress.queued + progress.processing;
      if (progress.total >= expectedTotal && inFlight === 0) {
        resolve(summary);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out; progress=${JSON.stringify(progress)}`));
        return;
      }
      setTimeout(poll, 50);
    };
    void poll();
  });
}

describe("batch generation: end-to-end", () => {
  it(
    "creates one independent job per selected image and finishes ALL SUCCEEDED",
    async () => {
      const [p1, p2, p3] = await Promise.all([
        seedProduct("gid://shopify/Product/1"),
        seedProduct("gid://shopify/Product/2"),
        seedProduct("gid://shopify/Product/3"),
      ]);
      const selectionId = await createImageSelection(CONTEXT, [
        { productId: p1.id, productMediaId: p1.media[0].id },
        { productId: p2.id, productMediaId: p2.media[0].id },
        { productId: p3.id, productMediaId: p3.media[0].id },
      ]);

      const { batchId, jobCount } = await startBatchGeneration(CONTEXT, {
        selectionId,
        generationType: "LIFESTYLE",
        presetId: "natural-lifestyle",
      });
      expect(jobCount).toBe(3);

      const summary = await waitForTerminal(batchId, 3, 15000);
      expect(summary!.progress.total).toBe(3);
      expect(summary!.progress.succeeded).toBe(3);
      expect(summary!.progress.failed).toBe(0);
      expect(summary!.jobs).toHaveLength(3);
      expect(summary!.jobs.every((job) => job.results.length === 1)).toBe(true);
      expect(summary!.jobs.every((job) => job.type === "LIFESTYLE")).toBe(true);
    },
    20000,
  );

  it(
    "one product's job failing to even be CREATED (never analyzed) does not block the others",
    async () => {
      const [analyzed1, unanalyzed, analyzed2] = await Promise.all([
        seedProduct("gid://shopify/Product/10"),
        seedProduct("gid://shopify/Product/11", { analyzed: false }),
        seedProduct("gid://shopify/Product/12"),
      ]);
      const selectionId = await createImageSelection(CONTEXT, [
        { productId: analyzed1.id, productMediaId: analyzed1.media[0].id },
        { productId: unanalyzed.id, productMediaId: unanalyzed.media[0].id },
        { productId: analyzed2.id, productMediaId: analyzed2.media[0].id },
      ]);

      const { batchId, jobCount } = await startBatchGeneration(CONTEXT, {
        selectionId,
        generationType: "LIFESTYLE",
      });
      // The unanalyzed product's job creation was skipped (logged, not
      // thrown) — only 2 jobs actually exist in this batch.
      expect(jobCount).toBe(2);

      const summary = await waitForTerminal(batchId, 2, 15000);
      expect(summary!.progress.total).toBe(2);
      expect(summary!.progress.succeeded).toBe(2);
      expect(summary!.jobs.map((job) => job.productId).sort()).toEqual([analyzed1.id, analyzed2.id].sort());
    },
    20000,
  );

  it("throws SelectionNotFoundError for a selection that doesn't exist", async () => {
    const { SelectionNotFoundError } = await import("../../../services/generation/batch.server");
    await expect(
      startBatchGeneration(CONTEXT, { selectionId: "does-not-exist", generationType: "LIFESTYLE" }),
    ).rejects.toThrow(SelectionNotFoundError);
  });

  it("throws InvalidBatchRequestError for an unknown generationType", async () => {
    const { InvalidBatchRequestError } = await import("../../../services/generation/batch.server");
    const p1 = await seedProduct("gid://shopify/Product/20");
    const selectionId = await createImageSelection(CONTEXT, [{ productId: p1.id, productMediaId: p1.media[0].id }]);

    await expect(startBatchGeneration(CONTEXT, { selectionId, generationType: "NOT_A_REAL_TYPE" })).rejects.toThrow(
      InvalidBatchRequestError,
    );
  });

  it("getGenerationBatchSummary throws TenantMismatchError for a batch belonging to another shop", async () => {
    const otherShop = `${SHOP}-other`;
    const otherContext: AuthContext = { shop: otherShop, sessionId: "s2", isOnline: false };
    const p1 = await seedProduct("gid://shopify/Product/30");
    const selectionId = await createImageSelection(CONTEXT, [{ productId: p1.id, productMediaId: p1.media[0].id }]);
    const { batchId } = await startBatchGeneration(CONTEXT, { selectionId, generationType: "LIFESTYLE" });

    const { TenantMismatchError } = await import("../../../lib/auth/tenant.server");
    await expect(getGenerationBatchSummary(otherContext, batchId)).rejects.toThrow(TenantMismatchError);

    await prisma.shopifyProduct.deleteMany({ where: { shop: otherShop } });
  });
});

describe("MODEL_SHOOT batch generation", () => {
  it(
    "one product that isn't model-suitable is skipped (job creation fails), without blocking the others",
    async () => {
      const [suitable1, notSuitable, suitable2] = await Promise.all([
        seedProduct("gid://shopify/Product/40", { modelSuitable: true }),
        seedProduct("gid://shopify/Product/41", { modelSuitable: false }),
        seedProduct("gid://shopify/Product/42", { modelSuitable: true }),
      ]);
      const selectionId = await createImageSelection(CONTEXT, [
        { productId: suitable1.id, productMediaId: suitable1.media[0].id },
        { productId: notSuitable.id, productMediaId: notSuitable.media[0].id },
        { productId: suitable2.id, productMediaId: suitable2.media[0].id },
      ]);

      const { batchId, jobCount } = await startBatchGeneration(CONTEXT, {
        selectionId,
        generationType: "MODEL_SHOOT",
      });
      expect(jobCount).toBe(2); // the not-suitable product's job creation was skipped

      const summary = await waitForTerminal(batchId, 2, 15000);
      expect(summary!.progress.total).toBe(2);
      expect(summary!.progress.succeeded).toBe(2);
      expect(summary!.jobs.map((job) => job.productId).sort()).toEqual([suitable1.id, suitable2.id].sort());
    },
    20000,
  );

  it("an aspectRatio applies to every job in the batch", async () => {
    const p1 = await seedProduct("gid://shopify/Product/50", { modelSuitable: true });
    const selectionId = await createImageSelection(CONTEXT, [{ productId: p1.id, productMediaId: p1.media[0].id }]);

    const { batchId } = await startBatchGeneration(CONTEXT, {
      selectionId,
      generationType: "MODEL_SHOOT",
      aspectRatio: "16:9",
    });
    const summary = await waitForTerminal(batchId, 1, 15000);
    const plan = summary!.jobs[0].plan as { aspectRatio: string };
    expect(plan.aspectRatio).toBe("16:9");
  });
});
