/**
 * Unit test: lib/storage/resign.server.ts's `resignResultUrls` — the fix
 * for the "stored `.url` expires after an hour and is never re-signed on
 * read" bug (see that file's doc comment). The real storage provider is
 * mocked here so this stays a pure unit test of the re-signing logic
 * itself; tests/integration/generation/generation-url-resign.test.ts
 * covers the real end-to-end behavior against the real
 * LocalFilesystemStorageProvider.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getSignedUrl = vi.fn();
vi.mock("../../../lib/storage/provider.server", () => ({
  getConfiguredStorageProvider: () => ({ name: "fake", getSignedUrl }),
}));

import { resignResultUrls } from "../../../lib/storage/resign.server";

beforeEach(() => {
  getSignedUrl.mockReset();
});

describe("resignResultUrls", () => {
  it("returns an empty array unchanged without calling the storage provider", async () => {
    const result = await resignResultUrls([]);
    expect(result).toEqual([]);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("replaces each result's url with a freshly-signed one from its storageKey", async () => {
    getSignedUrl.mockImplementation(async ({ key }: { key: string }) => `fresh://${key}`);

    const input = [
      { id: "r1", storageKey: "shops/x/a.png", url: "stale://a" },
      { id: "r2", storageKey: "shops/x/b.png", url: null },
    ];
    const result = await resignResultUrls(input);

    expect(result).toEqual([
      { id: "r1", storageKey: "shops/x/a.png", url: "fresh://shops/x/a.png" },
      { id: "r2", storageKey: "shops/x/b.png", url: "fresh://shops/x/b.png" },
    ]);
  });

  it("requests a 'get' operation with a one-hour lifetime", async () => {
    getSignedUrl.mockResolvedValue("fresh://x");
    await resignResultUrls([{ storageKey: "shops/x/a.png", url: null }]);

    expect(getSignedUrl).toHaveBeenCalledWith({ key: "shops/x/a.png", expiresInSeconds: 3600, operation: "get" });
  });

  it("preserves every other field on the result untouched", async () => {
    getSignedUrl.mockResolvedValue("fresh://x");
    const result = await resignResultUrls([{ storageKey: "k", url: "old", width: 800, height: 600, format: "png" }]);
    expect(result[0]).toMatchObject({ width: 800, height: 600, format: "png" });
  });
});
