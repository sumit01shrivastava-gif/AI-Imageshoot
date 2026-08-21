/**
 * S3-compatible object storage — the production `StorageProvider`
 * implementation. "S3-compatible" is a protocol, not one commercial
 * vendor: AWS S3, Cloudflare R2, MinIO, Backblaze B2, and DigitalOcean
 * Spaces all speak the identical S3 REST API, so this one class covers
 * every one of them via `OBJECT_STORAGE_ENDPOINT` — selecting it isn't
 * "arbitrarily hardcoding a commercial vendor" the way picking one AI
 * generation vendor would be (see docs/storage.md and
 * services/ai/production-image-generation-provider.server.ts's doc
 * comment for the same reasoning applied there).
 *
 * Built on `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — the
 * one new dependency this pass adds, and a deliberate exception to
 * "prefer direct HTTP APIs" (services/ai/'s guidance): correctly
 * implementing AWS SigV4 request signing by hand is a well-known source
 * of subtle, hard-to-verify bugs, and this app has no live bucket in
 * this environment to test a hand-rolled signer against. The official
 * SDK is minimal, widely used exactly for this "talk to any S3-compatible
 * endpoint" purpose, and is the safer choice for something this
 * security/correctness-sensitive.
 *
 * Selected by lib/storage/provider.server.ts only when
 * `OBJECT_STORAGE_PROVIDER=s3` and bucket/credentials are present —
 * `LocalFilesystemStorageProvider` remains the default for
 * development/test. See docs/storage.md "Production configuration".
 *
 * `getSignedUrl` returns a REAL, time-limited pre-signed S3 URL (unlike
 * `LocalFilesystemStorageProvider`'s own HMAC-signed `/media/*` app
 * route — there is no `/media/*` indirection needed here, since a
 * pre-signed S3 URL is already a direct, self-authorizing link to the
 * object). Never exposes the bucket's access/secret key to a client —
 * signing happens entirely server-side; the returned URL carries a scoped,
 * expiring signature, not the credentials themselves.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "../validation/env.server";
import type { DownloadResult, SignedUrlOptions, StorageProvider, UploadInput, UploadResult } from "./types";

let cachedClient: S3Client | undefined;
let cachedClientConfigKey: string | undefined;

/** Rebuilds the client if the relevant env values change between calls
 * (mirrors resolveRoot()'s "cheap to recompute" approach in the local
 * filesystem provider) — matters for tests that reconfigure env and call
 * `resetConfiguredStorageProviderForTests`. */
function getClient(): S3Client {
  const env = getEnv();
  const configKey = `${env.OBJECT_STORAGE_ENDPOINT ?? ""}:${env.OBJECT_STORAGE_REGION}:${env.OBJECT_STORAGE_ACCESS_KEY ?? ""}`;
  if (!cachedClient || cachedClientConfigKey !== configKey) {
    cachedClient = new S3Client({
      region: env.OBJECT_STORAGE_REGION,
      ...(env.OBJECT_STORAGE_ENDPOINT ? { endpoint: env.OBJECT_STORAGE_ENDPOINT } : {}),
      // Required for most non-AWS S3-compatible vendors (R2, MinIO, ...),
      // harmless for real AWS S3.
      forcePathStyle: Boolean(env.OBJECT_STORAGE_ENDPOINT),
      credentials: {
        accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY ?? "",
        secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY ?? "",
      },
    });
    cachedClientConfigKey = configKey;
  }
  return cachedClient;
}

function requireBucket(): string {
  const bucket = getEnv().OBJECT_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error("S3StorageProvider requires OBJECT_STORAGE_BUCKET to be set.");
  }
  return bucket;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";

  async upload(input: UploadInput): Promise<UploadResult> {
    const body = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    await getClient().send(
      new PutObjectCommand({
        Bucket: requireBucket(),
        Key: input.key,
        Body: body,
        ContentType: input.contentType,
      }),
    );
    return { key: input.key, size: body.byteLength };
  }

  async download(key: string): Promise<DownloadResult> {
    const response = await getClient().send(new GetObjectCommand({ Bucket: requireBucket(), Key: key }));
    if (!response.Body) {
      throw new Error(`S3StorageProvider: no object at key "${key}"`);
    }
    const body = await response.Body.transformToByteArray();
    return { key, body, contentType: response.ContentType ?? "application/octet-stream" };
  }

  async delete(key: string): Promise<void> {
    await getClient().send(new DeleteObjectCommand({ Bucket: requireBucket(), Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await getClient().send(new HeadObjectCommand({ Bucket: requireBucket(), Key: key }));
      return true;
    } catch (error) {
      // The SDK throws a `NotFound`-named error (S3) — anything else
      // (network, auth) should propagate rather than be reported as "the
      // object doesn't exist", which would be misleading.
      if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) {
        return false;
      }
      throw error;
    }
  }

  async getSignedUrl(options: SignedUrlOptions): Promise<string> {
    const command =
      options.operation === "put"
        ? new PutObjectCommand({ Bucket: requireBucket(), Key: options.key })
        : new GetObjectCommand({ Bucket: requireBucket(), Key: options.key });
    return presign(getClient(), command, { expiresIn: options.expiresInSeconds });
  }
}

/** Test-only: forces a fresh client so a test that changes env between
 * cases doesn't reuse a stale client. Mirrors
 * lib/storage/provider.server.ts's `resetConfiguredStorageProviderForTests`. */
export function resetS3ClientForTests(): void {
  cachedClient = undefined;
  cachedClientConfigKey = undefined;
}
