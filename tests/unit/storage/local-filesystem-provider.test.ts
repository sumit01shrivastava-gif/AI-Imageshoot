/**
 * Unit tests: lib/storage/local-filesystem-provider.server.ts — real file
 * I/O against a scratch temp directory (not the project's own
 * `.data/storage`), so this exercises the real implementation rather than
 * a mock, without touching anything checked into the repo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import {
  LocalFilesystemStorageProvider,
  verifyMediaUrlSignature,
} from "../../../lib/storage/local-filesystem-provider.server";

let scratchDir: string;

beforeAll(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "ai-imageshoot-storage-test-"));
});

beforeEach(() => {
  process.env.STORAGE_LOCAL_ROOT = scratchDir;
  resetEnvCacheForTests();
});

afterAll(async () => {
  await rm(scratchDir, { recursive: true, force: true });
  delete process.env.STORAGE_LOCAL_ROOT;
  resetEnvCacheForTests();
});

function parseSignedUrl(url: string): { key: string; expires: string | null; sig: string | null } {
  const parsed = new URL(url, "http://localhost");
  const key = decodeURIComponent(parsed.pathname.replace(/^\/media\//, ""));
  return { key, expires: parsed.searchParams.get("expires"), sig: parsed.searchParams.get("sig") };
}

describe("LocalFilesystemStorageProvider", () => {
  it("round-trips upload -> download with the same bytes and content type", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const key = "shops/shop-a/processing/job-1/0.png";
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    const uploaded = await provider.upload({ key, body, contentType: "image/png" });
    expect(uploaded.key).toBe(key);
    expect(uploaded.size).toBe(5);

    const downloaded = await provider.download(key);
    expect([...downloaded.body]).toEqual([1, 2, 3, 4, 5]);
    expect(downloaded.contentType).toBe("image/png");
  });

  it("throws for a key that was never uploaded", async () => {
    const provider = new LocalFilesystemStorageProvider();
    await expect(provider.download("shops/shop-a/nope.png")).rejects.toThrow();
  });

  it("delete removes the object — a later download throws", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const key = "shops/shop-a/processing/job-2/0.png";
    await provider.upload({ key, body: new Uint8Array([9]), contentType: "image/png" });
    expect(await provider.has(key)).toBe(true);

    await provider.delete(key);
    expect(await provider.has(key)).toBe(false);
    await expect(provider.download(key)).rejects.toThrow();
  });

  it("rejects a key that would escape the configured root", async () => {
    const provider = new LocalFilesystemStorageProvider();
    await expect(provider.download("../../etc/passwd")).rejects.toThrow(/outside the configured root/);
  });

  it("getSignedUrl produces a /media/<key> path carrying expires + sig", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const key = "shops/shop-a/processing/job-3/0.png";
    const url = await provider.getSignedUrl({ key, expiresInSeconds: 60, operation: "get" });

    expect(url.startsWith("/media/")).toBe(true);
    const { key: parsedKey, expires, sig } = parseSignedUrl(url);
    expect(parsedKey).toBe(key);
    expect(expires).not.toBeNull();
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getSignedUrl preserves '/' as path separators across multi-segment keys", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const key = "shops/shop-a/generations/job-4/0.png";
    const url = await provider.getSignedUrl({ key, expiresInSeconds: 60, operation: "get" });
    const { key: parsedKey } = parseSignedUrl(url);
    expect(parsedKey).toBe(key);
  });

  it("getSignedUrl rejects 'put' — no client-side direct upload support yet", async () => {
    const provider = new LocalFilesystemStorageProvider();
    await expect(
      provider.getSignedUrl({ key: "shops/shop-a/x.png", expiresInSeconds: 60, operation: "put" }),
    ).rejects.toThrow();
  });
});

describe("verifyMediaUrlSignature", () => {
  it("accepts a signature produced by getSignedUrl for the same key", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const key = "shops/shop-a/processing/job-5/0.png";
    const url = await provider.getSignedUrl({ key, expiresInSeconds: 60, operation: "get" });
    const { expires, sig } = parseSignedUrl(url);

    expect(verifyMediaUrlSignature(key, expires, sig)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const key = "shops/shop-a/processing/job-6/0.png";
    const url = await provider.getSignedUrl({ key, expiresInSeconds: 60, operation: "get" });
    const { expires } = parseSignedUrl(url);

    expect(verifyMediaUrlSignature(key, expires, "0".repeat(64))).toBe(false);
  });

  it("rejects a signature issued for a different key", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const url = await provider.getSignedUrl({
      key: "shops/shop-a/processing/job-7/0.png",
      expiresInSeconds: 60,
      operation: "get",
    });
    const { expires, sig } = parseSignedUrl(url);

    expect(verifyMediaUrlSignature("shops/shop-a/processing/job-OTHER/0.png", expires, sig)).toBe(false);
  });

  it("rejects an expired signature", async () => {
    const provider = new LocalFilesystemStorageProvider();
    const key = "shops/shop-a/processing/job-8/0.png";
    const url = await provider.getSignedUrl({ key, expiresInSeconds: -60, operation: "get" });
    const { expires, sig } = parseSignedUrl(url);

    expect(verifyMediaUrlSignature(key, expires, sig)).toBe(false);
  });

  it("rejects missing params", () => {
    expect(verifyMediaUrlSignature("shops/shop-a/x.png", null, null)).toBe(false);
  });
});
