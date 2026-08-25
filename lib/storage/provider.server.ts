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
 *
 * ## This app's deployment topology makes the local-filesystem fallback
 * dangerous in a way the original doc comment above didn't anticipate
 *
 * This app runs as TWO separate processes on TWO separate hosts in
 * production — the web app (Vercel, serverless) and the BullMQ worker
 * (Railway, long-lived) — each with its own independently-configured
 * environment. `LocalFilesystemStorageProvider` writes to (and reads
 * from) whichever host's own ephemeral/local disk the calling process
 * happens to be running on. A generation job's upload always happens
 * inside the WORKER (services/generation/job.server.ts); the resulting
 * signed `/media/*` URL is always later resolved by the WEB APP
 * (app/routes/media.$.tsx), a DIFFERENT process on a DIFFERENT host.
 *
 * If the worker's host is missing (or has incomplete) `OBJECT_STORAGE_*`
 * configuration while the web app's host has it fully configured (or
 * vice versa), `isS3Configured()` below resolves DIFFERENTLY on each
 * side — one process silently falls back to local-filesystem, the other
 * uses S3 — and every image this app generates uploads successfully
 * (from the worker's own honest point of view) to a location the web
 * app can never read from. The result: "Your image is ready," a
 * Download button that produces "File wasn't available on site," and a
 * broken image in the UI — with NO error anywhere in the pipeline,
 * because nothing actually failed on the writing side. This is a real
 * incident this comment documents, found via direct production
 * evidence (the persisted `GenerationResult.url` was a `/media/*` path
 * — proving the worker used the local-filesystem provider — while the
 * web app's own environment had full S3 credentials configured).
 *
 * This module can't detect or prevent that mismatch by itself — it only
 * ever sees its OWN process's environment — but every resolution now
 * logs which provider it picked (see `logger.info` below), specifically
 * so comparing the web app's and the worker's own startup/first-request
 * logs makes a future instance of this same mismatch immediately
 * visible instead of requiring manual database inspection to diagnose,
 * as this one did.
 */
import { getEnv } from "../validation/env.server";
import { logger } from "../logging/logger.server";
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
    const s3Configured = isS3Configured();
    provider = s3Configured ? new S3StorageProvider() : new LocalFilesystemStorageProvider();
    // Safe — never a credential value, only presence/absence and which
    // provider this specific process resolved to. Field names
    // deliberately avoid the logger's own secret-shaped-key redaction
    // pattern (lib/logging/logger.server.ts's SECRET_KEY_PATTERN matches
    // "secret"/"accesskey" as substrings regardless of the value's
    // type) — a boolean named e.g. `secretKeyPresent` would always print
    // as "[REDACTED]", destroying exactly the diagnostic value this line
    // exists to provide. See module doc comment above for why comparing
    // this line across the web app's and the worker's own logs is the
    // fast way to catch a cross-host storage-provider mismatch.
    logger.info("storage.provider.configured", {
      provider: provider.name,
      objectStorageProviderEnv: getEnv().OBJECT_STORAGE_PROVIDER ?? null,
      bucketConfigured: Boolean(getEnv().OBJECT_STORAGE_BUCKET),
      s3CredentialsComplete: Boolean(getEnv().OBJECT_STORAGE_ACCESS_KEY) && Boolean(getEnv().OBJECT_STORAGE_SECRET_KEY),
    });
  }
  return provider;
}

/** Test-only: forces a fresh provider instance so one test's uploaded
 * objects can't leak into another's assertions. */
export function resetConfiguredStorageProviderForTests(): void {
  provider = undefined;
}
