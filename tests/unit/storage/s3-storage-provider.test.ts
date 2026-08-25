/**
 * Unit tests: lib/storage/s3-storage-provider.server.ts — key-building
 * and command shape, and lib/storage/provider.server.ts's resolver logic
 * for selecting it. `@aws-sdk/client-s3`/`@aws-sdk/s3-request-presigner`
 * are mocked throughout — no real bucket exists in this environment (see
 * CLAUDE.md "Storage rules" and the module's own doc comment on why a
 * real, well-tested SDK is used here rather than a hand-rolled signer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { logger } from "../../../lib/logging/logger.server";

const sendMock = vi.fn();
const presignMock = vi.fn(async () => "https://bucket.s3.example.test/signed?X-Amz-Signature=abc");

vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
  class FakeS3Client {
    send = sendMock;
  }
  return {
    ...actual,
    S3Client: FakeS3Client,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: presignMock,
}));

function configureS3Env() {
  process.env.OBJECT_STORAGE_PROVIDER = "s3";
  process.env.OBJECT_STORAGE_BUCKET = "test-bucket";
  process.env.OBJECT_STORAGE_ACCESS_KEY = "test-access-key";
  process.env.OBJECT_STORAGE_SECRET_KEY = "test-secret-key";
  process.env.OBJECT_STORAGE_ENDPOINT = "https://s3-compatible.example.test";
  resetEnvCacheForTests();
}

function clearS3Env() {
  delete process.env.OBJECT_STORAGE_PROVIDER;
  delete process.env.OBJECT_STORAGE_BUCKET;
  delete process.env.OBJECT_STORAGE_ACCESS_KEY;
  delete process.env.OBJECT_STORAGE_SECRET_KEY;
  delete process.env.OBJECT_STORAGE_ENDPOINT;
  resetEnvCacheForTests();
}

beforeEach(() => {
  sendMock.mockReset();
  presignMock.mockClear();
});
afterEach(() => {
  clearS3Env();
  vi.restoreAllMocks();
});

describe("S3StorageProvider", () => {
  it("uploads with the given key/body/contentType against the configured bucket", async () => {
    configureS3Env();
    sendMock.mockResolvedValueOnce({});
    const { S3StorageProvider } = await import("../../../lib/storage/s3-storage-provider.server");
    const provider = new S3StorageProvider();

    const result = await provider.upload({ key: "shops/x/a.png", body: new Uint8Array([1, 2, 3]), contentType: "image/png" });

    expect(result).toEqual({ key: "shops/x/a.png", size: 3 });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command.input).toMatchObject({ Bucket: "test-bucket", Key: "shops/x/a.png", ContentType: "image/png" });
  });

  it("returns exists()=true when HeadObject succeeds, false on a NotFound error", async () => {
    configureS3Env();
    const { S3StorageProvider } = await import("../../../lib/storage/s3-storage-provider.server");
    const provider = new S3StorageProvider();

    sendMock.mockResolvedValueOnce({});
    expect(await provider.exists("shops/x/a.png")).toBe(true);

    const notFound = new Error("not found");
    notFound.name = "NotFound";
    sendMock.mockRejectedValueOnce(notFound);
    expect(await provider.exists("shops/x/missing.png")).toBe(false);
  });

  it("propagates a genuine (non-NotFound) error from exists() rather than reporting false", async () => {
    configureS3Env();
    const { S3StorageProvider } = await import("../../../lib/storage/s3-storage-provider.server");
    const provider = new S3StorageProvider();

    const authError = new Error("access denied");
    authError.name = "AccessDenied";
    sendMock.mockRejectedValueOnce(authError);

    await expect(provider.exists("shops/x/a.png")).rejects.toThrow("access denied");
  });

  it("deletes by key against the configured bucket", async () => {
    configureS3Env();
    sendMock.mockResolvedValueOnce({});
    const { S3StorageProvider } = await import("../../../lib/storage/s3-storage-provider.server");
    const provider = new S3StorageProvider();

    await provider.delete("shops/x/a.png");
    const command = sendMock.mock.calls[0][0];
    expect(command.input).toMatchObject({ Bucket: "test-bucket", Key: "shops/x/a.png" });
  });

  it("getSignedUrl returns a real pre-signed URL via the presigner, never the raw credentials", async () => {
    configureS3Env();
    const { S3StorageProvider } = await import("../../../lib/storage/s3-storage-provider.server");
    const provider = new S3StorageProvider();

    const url = await provider.getSignedUrl({ key: "shops/x/a.png", expiresInSeconds: 3600, operation: "get" });

    expect(url).toContain("X-Amz-Signature");
    expect(url).not.toContain("test-secret-key");
    expect(presignMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 3600 });
  });

  it("throws a clear error when the bucket is not configured", async () => {
    configureS3Env();
    delete process.env.OBJECT_STORAGE_BUCKET;
    resetEnvCacheForTests();
    const { S3StorageProvider } = await import("../../../lib/storage/s3-storage-provider.server");
    const provider = new S3StorageProvider();

    await expect(provider.upload({ key: "k", body: new Uint8Array([1]), contentType: "image/png" })).rejects.toThrow(
      "OBJECT_STORAGE_BUCKET",
    );
  });
});

describe("getConfiguredStorageProvider — resolver", () => {
  it("selects S3StorageProvider when OBJECT_STORAGE_PROVIDER=s3 and credentials are present", async () => {
    configureS3Env();
    const { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } = await import("../../../lib/storage/provider.server");
    resetConfiguredStorageProviderForTests();
    expect(getConfiguredStorageProvider().name).toBe("s3");
  });

  it("falls back to LocalFilesystemStorageProvider when object storage isn't configured", async () => {
    clearS3Env();
    const { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } = await import("../../../lib/storage/provider.server");
    resetConfiguredStorageProviderForTests();
    expect(getConfiguredStorageProvider().name).toBe("local-filesystem");
  });

  it("falls back to local when OBJECT_STORAGE_PROVIDER=s3 but credentials are incomplete", async () => {
    configureS3Env();
    delete process.env.OBJECT_STORAGE_SECRET_KEY;
    resetEnvCacheForTests();
    const { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } = await import("../../../lib/storage/provider.server");
    resetConfiguredStorageProviderForTests();
    expect(getConfiguredStorageProvider().name).toBe("local-filesystem");
  });

  // Regression coverage for the real production incident this logging
  // exists to make diagnosable: the web app and the worker resolved to
  // DIFFERENT storage providers because only one host's environment had
  // full OBJECT_STORAGE_* credentials — every generated image uploaded
  // successfully (from the worker's own honest point of view) to a
  // location the web app could never read back from. See
  // lib/storage/provider.server.ts's module doc comment.
  it("logs which provider was resolved and whether S3 credentials are complete — safely, without ever being redacted as a secret", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    configureS3Env();
    const { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } = await import("../../../lib/storage/provider.server");
    resetConfiguredStorageProviderForTests();
    getConfiguredStorageProvider();

    const call = infoSpy.mock.calls.find(([message]) => message === "storage.provider.configured");
    expect(call).toBeDefined();
    const fields = call![1] as Record<string, unknown>;
    expect(fields.provider).toBe("s3");
    expect(fields.bucketConfigured).toBe(true);
    expect(fields.s3CredentialsComplete).toBe(true);
    // The whole point of this test: these must be real booleans, never
    // the logger's own "[REDACTED]" string — a field literally named
    // e.g. `secretKeyPresent` would defeat its own purpose here.
    expect(JSON.stringify(fields)).not.toContain("REDACTED");
    expect(JSON.stringify(fields)).not.toContain("test-secret-key");
    expect(JSON.stringify(fields)).not.toContain("test-access-key");
  });

  it("logs a false s3CredentialsComplete when falling back to local", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    clearS3Env();
    const { getConfiguredStorageProvider, resetConfiguredStorageProviderForTests } = await import("../../../lib/storage/provider.server");
    resetConfiguredStorageProviderForTests();
    getConfiguredStorageProvider();

    const call = infoSpy.mock.calls.find(([message]) => message === "storage.provider.configured");
    const fields = call![1] as Record<string, unknown>;
    expect(fields.provider).toBe("local-filesystem");
    expect(fields.s3CredentialsComplete).toBe(false);
  });
});
