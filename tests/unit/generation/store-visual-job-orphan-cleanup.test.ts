/**
 * Unit test: services/store-visuals/job.server.ts's orphaned-storage
 * cleanup — mirrors tests/unit/generation/job-orphan-cleanup.test.ts
 * exactly (see that file's doc comment for the full reasoning); this file
 * exists because store-visuals' processor has its own, separately
 * maintained copy of the same cleanup logic, not a shared function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { logger } from "../../../lib/logging/logger.server";

const getStoreVisualJob = vi.fn();
const markProcessing = vi.fn();
const markSucceeded = vi.fn();
const markFailed = vi.fn();
const createResults = vi.fn();

vi.mock("../../../db/repositories/store-visual-job.repository", () => ({
  getStoreVisualJob: (...args: unknown[]) => getStoreVisualJob(...args),
  markProcessing: (...args: unknown[]) => markProcessing(...args),
  markSucceeded: (...args: unknown[]) => markSucceeded(...args),
  markFailed: (...args: unknown[]) => markFailed(...args),
  createResults: (...args: unknown[]) => createResults(...args),
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

const recordUsageEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../services/usage/usage-accounting.server", () => ({
  recordUsageEvent: (...args: unknown[]) => recordUsageEvent(...args),
}));

const PLAN = {
  visualType: "HOMEPAGE_HERO",
  products: [],
  creativeDirection: { prompt: "A welcoming storefront scene.", negativeConstraints: [], environment: null, lighting: null, composition: null },
  aspectRatio: "16:9",
  outputFormat: "png",
  quality: "standard",
  outputCount: 2,
  brandStyle: null,
  constraints: [],
};

function fakeJob(): Job<{ shop: string; storeVisualJobId: string }> {
  return {
    data: { shop: "orphan-test.myshopify.com", storeVisualJobId: "job-1" },
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as unknown as Job<{ shop: string; storeVisualJobId: string }>;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getStoreVisualJob.mockReset().mockResolvedValue({ status: "PROCESSING", plan: PLAN });
  markProcessing.mockReset().mockResolvedValue(undefined);
  markSucceeded.mockReset().mockResolvedValue(undefined);
  markFailed.mockReset().mockResolvedValue(undefined);
  createResults.mockReset();
  storageUpload.mockReset().mockImplementation(async ({ key }: { key: string }) => ({ key, size: 4 }));
  storageGetSignedUrl.mockReset().mockResolvedValue("https://signed.example.test/x");
  storageDelete.mockReset().mockResolvedValue(undefined);
  recordUsageEvent.mockReset().mockResolvedValue(undefined);
  generateImage.mockReset().mockResolvedValue({
    outputs: [
      { data: new Uint8Array([1, 2, 3, 4]), contentType: "image/png" },
      { data: new Uint8Array([5, 6, 7, 8]), contentType: "image/png" },
    ],
  });
  warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
});

describe("processStoreVisualJob — orphaned-storage cleanup", () => {
  it("deletes every just-uploaded object when createResults fails, then rethrows", async () => {
    createResults.mockRejectedValue(new Error("simulated DB write failure"));

    const { processStoreVisualJob } = await import("../../../services/store-visuals/job.server");

    await expect(processStoreVisualJob(fakeJob(), "fake-token")).rejects.toThrow("simulated DB write failure");

    expect(storageUpload).toHaveBeenCalledTimes(2);
    expect(storageDelete).toHaveBeenCalledTimes(2);
    const deletedKeys = storageDelete.mock.calls.map((call) => call[0]);
    for (const call of storageUpload.mock.calls) {
      expect(deletedKeys).toContain(call[0].key);
    }
  });

  it("does not attempt cleanup when createResults succeeds", async () => {
    createResults.mockResolvedValue(undefined);

    const { processStoreVisualJob } = await import("../../../services/store-visuals/job.server");
    await processStoreVisualJob(fakeJob(), "fake-token");

    expect(storageDelete).not.toHaveBeenCalled();
    expect(markSucceeded).toHaveBeenCalledTimes(1);
  });

  it("cleans up an already-uploaded output when a LATER output's upload fails (partial multi-output failure)", async () => {
    // outputCount: 2 (see PLAN above) — output 1's upload succeeds,
    // output 2's fails. `Promise.all` would have discarded output 1's
    // already-resolved storage key the instant output 2 rejected,
    // orphaning it forever.
    let callCount = 0;
    storageUpload.mockImplementation(async ({ key }: { key: string }) => {
      callCount += 1;
      if (callCount === 2) throw new Error("simulated upload failure for output 2");
      return { key, size: 4 };
    });

    const { processStoreVisualJob } = await import("../../../services/store-visuals/job.server");

    await expect(processStoreVisualJob(fakeJob(), "fake-token")).rejects.toThrow("simulated upload failure for output 2");

    expect(storageUpload).toHaveBeenCalledTimes(2);
    expect(createResults).not.toHaveBeenCalled();
    const succeededKey = (storageUpload.mock.calls[0][0] as { key: string }).key;
    expect(storageDelete).toHaveBeenCalledTimes(1);
    expect(storageDelete).toHaveBeenCalledWith(succeededKey);

    expect(warnSpy).toHaveBeenCalledWith(
      "store_visual.job.partial_upload_failure",
      expect.objectContaining({ attemptedOutputs: 2, succeededOutputs: 1, failedOutputs: 1 }),
    );
  });
});
