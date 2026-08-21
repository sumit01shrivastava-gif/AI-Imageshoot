/**
 * Resolves which `StorageProvider` the app uses.
 *
 * `LocalFilesystemStorageProvider` (Phase 4) remains the default —
 * genuinely persistent, zero-configuration, correct for development/test
 * and a single-host deployment. `S3StorageProvider` (this pass) is
 * selected whenever `OBJECT_STORAGE_PROVIDER=s3` and the bucket/
 * credentials are present — mirrors
 * services/processing/provider.server.ts's exact "real vendor selected
 * via an env value, not via NODE_ENV" resolution shape. See
 * docs/storage.md "Production configuration".
 */
import { getEnv } from "../validation/env.server";
import type { StorageProvider } from "./types";
import { LocalFilesystemStorageProvider } from "./local-filesystem-provider.server";
import { S3StorageProvider } from "./s3-storage-provider.server";

let provider: StorageProvider | undefined;

function isS3Configured(): boolean {
  const env = getEnv();
  return env.OBJECT_STORAGE_PROVIDER === "s3" && Boolean(env.OBJECT_STORAGE_BUCKET) && Boolean(env.OBJECT_STORAGE_ACCESS_KEY) && Boolean(env.OBJECT_STORAGE_SECRET_KEY);
}

export function getConfiguredStorageProvider(): StorageProvider {
  if (!provider) {
    provider = isS3Configured() ? new S3StorageProvider() : new LocalFilesystemStorageProvider();
  }
  return provider;
}

/** Test-only: forces a fresh provider instance so one test's uploaded
 * objects can't leak into another's assertions. */
export function resetConfiguredStorageProviderForTests(): void {
  provider = undefined;
}
