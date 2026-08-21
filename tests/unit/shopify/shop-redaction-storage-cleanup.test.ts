/**
 * Unit test: services/shopify/shop-redaction.server.ts's storage-cleanup
 * step — a mocked-Prisma, mocked-storage counterpart to
 * tests/integration/shopify/shop-redaction.server.test.ts (which proves
 * the real, happy-path behavior against real Postgres/local storage).
 * This file exists specifically to force the one behavior a real local
 * `StorageProvider.delete` can't easily be made to fail on demand:
 * ONE storage object's deletion rejecting, to prove that failure is
 * counted/logged and never allowed to abort the mandatory DB redaction
 * itself (see that file's module doc comment — a Shopify-deadline-bound
 * compliance operation must not be blockable by an unrelated storage
 * hiccup).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

function fakeModel(rows: Array<{ storageKey: string }> = []) {
  return {
    findMany: vi.fn().mockResolvedValue(rows),
    deleteMany: vi.fn().mockResolvedValue({ count: rows.length }),
  };
}

const prismaMock = {
  generationResult: fakeModel([{ storageKey: "shops/s/generation/1/0.png" }]),
  processingResult: fakeModel([{ storageKey: "shops/s/processing/1/0.png" }]),
  storeVisualResult: fakeModel([{ storageKey: "shops/s/store-visuals/1/0.png" }]),
  storeVisualJobProduct: fakeModel(),
  storeVisualJob: fakeModel(),
  generationBatch: fakeModel(),
  processingBatch: fakeModel(),
  shopifyProduct: fakeModel(),
  generationJob: fakeModel(),
  processingJob: fakeModel(),
  imageSelectionItem: fakeModel(),
  imageSelection: fakeModel(),
  brandStylePreset: fakeModel(),
  shopSettings: fakeModel(),
  shopSyncState: fakeModel(),
  session: fakeModel(),
};

vi.mock("../../../db/client.server", () => ({ default: prismaMock }));

const storageDelete = vi.fn();
vi.mock("../../../lib/storage", () => ({
  getConfiguredStorageProvider: () => ({ name: "fake", delete: storageDelete }),
}));

beforeEach(() => {
  for (const model of Object.values(prismaMock)) {
    model.findMany.mockClear();
    model.deleteMany.mockClear();
  }
  storageDelete.mockReset();
});

describe("redactShopData — storage cleanup", () => {
  it("deletes every referenced storage object and reports an accurate count when all succeed", async () => {
    storageDelete.mockResolvedValue(undefined);

    const { redactShopData } = await import("../../../services/shopify/shop-redaction.server");
    const summary = await redactShopData("s");

    expect(storageDelete).toHaveBeenCalledTimes(3);
    expect(summary.storageObjectsDeleted).toBe(3);
    expect(summary.storageObjectsFailed).toBe(0);
  });

  it("counts and logs a storage delete failure WITHOUT aborting the DB redaction", async () => {
    storageDelete.mockImplementation(async (key: string) => {
      if (key === "shops/s/processing/1/0.png") throw new Error("simulated storage outage");
    });

    const { redactShopData } = await import("../../../services/shopify/shop-redaction.server");
    const summary = await redactShopData("s");

    // 2 succeeded, 1 failed — accurately reflected, never silently
    // dropped or rounded up to "all succeeded".
    expect(summary.storageObjectsDeleted).toBe(2);
    expect(summary.storageObjectsFailed).toBe(1);

    // The DB redaction proceeded regardless — every deleteMany the
    // function is responsible for still ran.
    for (const model of Object.values(prismaMock)) {
      expect(model.deleteMany).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a 0/0 storage summary for a shop with no results (nothing to delete)", async () => {
    prismaMock.generationResult.findMany.mockResolvedValueOnce([]);
    prismaMock.processingResult.findMany.mockResolvedValueOnce([]);
    prismaMock.storeVisualResult.findMany.mockResolvedValueOnce([]);

    const { redactShopData } = await import("../../../services/shopify/shop-redaction.server");
    const summary = await redactShopData("empty-shop");

    expect(storageDelete).not.toHaveBeenCalled();
    expect(summary.storageObjectsDeleted).toBe(0);
    expect(summary.storageObjectsFailed).toBe(0);
  });
});
