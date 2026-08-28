/**
 * Unit test: services/generation/job.server.ts's orphaned-storage
 * cleanup — when the provider call and every upload succeed but the
 * DB write that would make the result(s) referenced (`createResults`)
 * fails, the just-uploaded storage object(s) must be deleted rather than
 * left orphaned. Every dependency is mocked here specifically to force
 * that exact failure path deterministically — the happy path and the
 * idempotency guard are covered by real-Postgres/real-queue integration
 * tests (tests/integration/generation/generation-idempotency.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";
import { logger } from "../../../lib/logging/logger.server";
import { ProviderInputError, ProviderRequestError } from "../../../services/ai/http-provider-utils.server";

const getGenerationJob = vi.fn();
const markProcessing = vi.fn();
const markSucceeded = vi.fn();
const markFailed = vi.fn();
const createResults = vi.fn();
const mergeGenerationResultMetadata = vi.fn();

vi.mock("../../../db/repositories/generation-job.repository", () => ({
  getGenerationJob: (...args: unknown[]) => getGenerationJob(...args),
  markProcessing: (...args: unknown[]) => markProcessing(...args),
  markSucceeded: (...args: unknown[]) => markSucceeded(...args),
  markFailed: (...args: unknown[]) => markFailed(...args),
  createResults: (...args: unknown[]) => createResults(...args),
  mergeGenerationResultMetadata: (...args: unknown[]) => mergeGenerationResultMetadata(...args),
}));

const storageUpload = vi.fn();
const storageGetSignedUrl = vi.fn();
const storageDelete = vi.fn();

vi.mock("../../../lib/storage", () => ({
  getConfiguredStorageProvider: () => ({
    name: "fake",
    upload: storageUpload,
    getSignedUrl: storageGetSignedUrl,
    delete: storageDelete,
  }),
}));

const generateImage = vi.fn();

vi.mock("../../../services/generation/provider.server", () => ({
  getConfiguredImageGenerationProvider: () => ({ name: "fake-provider", generateImage }),
}));

const evaluateQuality = vi.fn();
vi.mock("../../../services/generation/quality-evaluator.server", () => ({
  getConfiguredVisualQualityEvaluator: () => ({ name: "fake-quality", evaluate: (...args: unknown[]) => evaluateQuality(...args) }),
}));

// This is a unit test — recordUsageEvent would otherwise hit a real
// Postgres connection (see services/usage/usage-accounting.server.ts).
// The usage ledger itself is covered by
// tests/integration/usage/usage-accounting.test.ts against real
// Postgres.
const recordUsageEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../services/usage/usage-accounting.server", () => ({
  recordUsageEvent: (...args: unknown[]) => recordUsageEvent(...args),
}));

const settleGenerationCredits = vi.fn().mockResolvedValue(undefined);
const refundGenerationCredits = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../services/usage/entitlement.server", () => ({
  settleGenerationCredits: (...args: unknown[]) => settleGenerationCredits(...args),
  refundGenerationCredits: (...args: unknown[]) => refundGenerationCredits(...args),
}));

const PLAN = {
  generationType: "PRODUCT_CLEANUP",
  assetType: "product_studio",
  category: "Handbags",
  sourceProductId: "product-1",
  sourceImages: [{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: "Front", position: 0 }],
  productFacts: { identityAnchors: null },
  creativeDirection: { prompt: "Clean product photography.", negativeConstraints: [], environment: null, lighting: null, composition: null },
  aspectRatio: "1:1",
  outputFormat: "png",
  quality: "standard",
  outputCount: 2,
  modelConfiguration: null,
  brandStyle: null,
  lifestyleScene: null,
  constraints: [],
};

function fakeJob(): Job<{ shop: string; generationJobId: string }> {
  return {
    data: { shop: "orphan-test.myshopify.com", generationJobId: "job-1" },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as unknown as Job<{ shop: string; generationJobId: string }>;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getGenerationJob.mockReset().mockResolvedValue({ status: "PROCESSING", plan: PLAN });
  markProcessing.mockReset().mockResolvedValue(undefined);
  markSucceeded.mockReset().mockResolvedValue(undefined);
  markFailed.mockReset().mockResolvedValue(undefined);
  createResults.mockReset();
  mergeGenerationResultMetadata.mockReset().mockResolvedValue(undefined);
  storageUpload.mockReset().mockImplementation(async ({ key }: { key: string }) => ({ key, size: 4 }));
  storageGetSignedUrl.mockReset().mockResolvedValue("https://signed.example.test/x");
  storageDelete.mockReset().mockResolvedValue(undefined);
  recordUsageEvent.mockReset().mockResolvedValue(undefined);
  settleGenerationCredits.mockReset().mockResolvedValue(undefined);
  refundGenerationCredits.mockReset().mockResolvedValue(undefined);
  generateImage.mockReset().mockResolvedValue({
    outputs: [
      { data: new Uint8Array([1, 2, 3, 4]), contentType: "image/png" },
      { data: new Uint8Array([5, 6, 7, 8]), contentType: "image/png" },
    ],
  });
  evaluateQuality.mockReset().mockResolvedValue({
    dimensions: { productFidelity: 9, briefAdherence: 9, creativeConcept: 9, artDirection: 9, photographyRealism: 9, composition: 9, commercialUsefulness: 9, designExecution: 9, physicalIntegrity: 9, channelSuitability: 9 },
    criticalFailures: [], observations: ["ok"], correctionGuidance: [], confidence: 9,
  });
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
});

describe("processGenerationJob — orphaned-storage cleanup", () => {
  it("marks a deterministic invalid reference input terminally failed without consuming all retry attempts", async () => {
    generateImage.mockRejectedValue(new ProviderInputError("openai", "OpenAI rejected reference image input"));

    const { processGenerationJob } = await import("../../../services/generation/job.server");

    await expect(processGenerationJob(fakeJob(), "fake-token")).rejects.toBeInstanceOf(UnrecoverableError);

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(refundGenerationCredits).toHaveBeenCalledTimes(1);
  });

  it("marks any deterministic OpenAI input error terminally failed and refunds its one reservation", async () => {
    generateImage.mockRejectedValue(new ProviderInputError("openai", "OpenAI rejected deterministic image generation input"));

    const { processGenerationJob } = await import("../../../services/generation/job.server");

    await expect(processGenerationJob(fakeJob(), "fake-token")).rejects.toBeInstanceOf(UnrecoverableError);

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(refundGenerationCredits).toHaveBeenCalledTimes(1);
  });

  it("keeps a transient provider failure retryable before the final attempt", async () => {
    const transientError = new ProviderRequestError("openai", 503);
    generateImage.mockRejectedValue(transientError);

    const { processGenerationJob } = await import("../../../services/generation/job.server");

    await expect(processGenerationJob(fakeJob(), "fake-token")).rejects.toBe(transientError);

    expect(markFailed).not.toHaveBeenCalled();
    expect(refundGenerationCredits).not.toHaveBeenCalled();
  });

  it("deletes every just-uploaded object when createResults fails, then rethrows", async () => {
    createResults.mockRejectedValue(new Error("simulated DB write failure"));

    const { processGenerationJob } = await import("../../../services/generation/job.server");

    await expect(processGenerationJob(fakeJob(), "fake-token")).rejects.toThrow("simulated DB write failure");

    // Two outputs were uploaded (outputCount: 2)...
    expect(storageUpload).toHaveBeenCalledTimes(2);
    // ...and both are cleaned up after the DB write failed, by the exact
    // keys that were uploaded.
    expect(storageDelete).toHaveBeenCalledTimes(2);
    const deletedKeys = storageDelete.mock.calls.map((call) => call[0]);
    for (const call of storageUpload.mock.calls) {
      expect(deletedKeys).toContain(call[0].key);
    }

    // The job is still marked FAILED on the final attempt, same as any
    // other terminal failure.
    expect(markFailed).toHaveBeenCalledTimes(0); // attempt 1 of 3 — not final yet, per existing retry semantics
  });

  it("marks the job FAILED (not just rethrows silently) when this was the final attempt", async () => {
    createResults.mockRejectedValue(new Error("simulated DB write failure"));

    const { processGenerationJob } = await import("../../../services/generation/job.server");
    const finalAttemptJob = {
      data: { shop: "orphan-test.myshopify.com", generationJobId: "job-1" },
      attemptsMade: 2, // attempt 3 of 3 — final
      opts: { attempts: 3 },
    } as unknown as Job<{ shop: string; generationJobId: string }>;

    await expect(processGenerationJob(finalAttemptJob, "fake-token")).rejects.toThrow();

    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledTimes(2);
  });

  it("does not attempt cleanup when createResults succeeds", async () => {
    createResults.mockResolvedValue(undefined);

    const { processGenerationJob } = await import("../../../services/generation/job.server");
    await processGenerationJob(fakeJob(), "fake-token");

    expect(storageDelete).not.toHaveBeenCalled();
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  it("attaches each Quality Director result using the durable provider-output index, not an unstable result row order", async () => {
    createResults.mockResolvedValue(undefined);
    getGenerationJob
      .mockReset()
      .mockResolvedValueOnce({ status: "PROCESSING", plan: PLAN })
      .mockResolvedValueOnce({ status: "PROCESSING", plan: PLAN, createdAt: new Date() })
      .mockResolvedValueOnce({
        status: "PROCESSING",
        plan: PLAN,
        results: [
          { id: "result-second", metadata: { generationOutputIndex: 1 } },
          { id: "result-first", metadata: { generationOutputIndex: 0 } },
        ],
      })
      .mockResolvedValueOnce({ status: "PROCESSING", plan: PLAN, results: [] });
    evaluateQuality
      .mockResolvedValueOnce({
        dimensions: { productFidelity: 8, briefAdherence: 9, creativeConcept: 9, artDirection: 9, photographyRealism: 9, composition: 9, commercialUsefulness: 9, designExecution: 9, physicalIntegrity: 9, channelSuitability: 9 },
        criticalFailures: [], observations: ["first"], correctionGuidance: [], confidence: 9,
      })
      .mockResolvedValueOnce({
        dimensions: { productFidelity: 9, briefAdherence: 9, creativeConcept: 9, artDirection: 9, photographyRealism: 9, composition: 9, commercialUsefulness: 9, designExecution: 9, physicalIntegrity: 9, channelSuitability: 9 },
        criticalFailures: [], observations: ["second"], correctionGuidance: [], confidence: 9,
      });

    const { processGenerationJob } = await import("../../../services/generation/job.server");
    await processGenerationJob(fakeJob(), "fake-token");

    expect(mergeGenerationResultMetadata).toHaveBeenNthCalledWith(
      1,
      "orphan-test.myshopify.com",
      "result-first",
      expect.objectContaining({ qualityEvaluation: expect.objectContaining({ dimensions: expect.objectContaining({ productFidelity: 8 }) }) }),
    );
    expect(mergeGenerationResultMetadata).toHaveBeenNthCalledWith(
      2,
      "orphan-test.myshopify.com",
      "result-second",
      expect.objectContaining({ qualityEvaluation: expect.objectContaining({ dimensions: expect.objectContaining({ productFidelity: 9 }) }) }),
    );
  });

  it("a cleanup failure is logged but never masks the original error", async () => {
    createResults.mockRejectedValue(new Error("simulated DB write failure"));
    storageDelete.mockRejectedValue(new Error("storage delete also failed"));

    const { processGenerationJob } = await import("../../../services/generation/job.server");

    await expect(processGenerationJob(fakeJob(), "fake-token")).rejects.toThrow("simulated DB write failure");
  });

  it("cleans up an already-uploaded output when a LATER output's upload fails (partial multi-output failure)", async () => {
    // outputCount: 2 (see PLAN above) — output 1's upload succeeds,
    // output 2's fails. `Promise.all` would have discarded output 1's
    // already-resolved storage key the instant output 2 rejected,
    // orphaning it forever; the fix under test uses `Promise.allSettled`
    // so the successful upload's key is still known and can be deleted.
    let callCount = 0;
    storageUpload.mockImplementation(async ({ key }: { key: string }) => {
      callCount += 1;
      if (callCount === 2) throw new Error("simulated upload failure for output 2");
      return { key, size: 4 };
    });

    const { processGenerationJob } = await import("../../../services/generation/job.server");

    await expect(processGenerationJob(fakeJob(), "fake-token")).rejects.toThrow("simulated upload failure for output 2");

    expect(storageUpload).toHaveBeenCalledTimes(2);
    // createResults must never be called — there was never a complete,
    // consistent set of stored results to persist.
    expect(createResults).not.toHaveBeenCalled();
    // Only the output that actually succeeded its upload is cleaned up —
    // by the exact key it was uploaded under.
    const succeededKey = (storageUpload.mock.calls[0][0] as { key: string }).key;
    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith(succeededKey);

    // The partial outcome (1 of 2 attempted, 1 succeeded, 1 failed) is
    // explicit and observable in the logs — not silently folded into the
    // generic attempt_failed event below it.
    expect(warnSpy).toHaveBeenCalledWith(
      "generation.job.partial_upload_failure",
      expect.objectContaining({ attemptedOutputs: 2, succeededOutputs: 1, failedOutputs: 1 }),
    );
  });
});

describe("processGenerationJob — idempotency guard", () => {
  it("returns early (no provider call, no writes) when the job is already SUCCEEDED", async () => {
    getGenerationJob.mockResolvedValue({ status: "SUCCEEDED", plan: PLAN });

    const { processGenerationJob } = await import("../../../services/generation/job.server");
    await processGenerationJob(fakeJob(), "fake-token");

    expect(generateImage).not.toHaveBeenCalled();
    expect(storageUpload).not.toHaveBeenCalled();
    expect(createResults).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
    // The guard is checked BEFORE markProcessing specifically because
    // markProcessing unconditionally overwrites status — an idempotent
    // no-op must never even call it (a real, once-caught bug: checking
    // the guard after markProcessing would always see "PROCESSING", never
    // "SUCCEEDED").
    expect(markProcessing).not.toHaveBeenCalled();
  });
});
