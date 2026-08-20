/**
 * Resolves which `StorageProvider` the app uses.
 *
 * No real storage vendor SDK is installed yet (see CLAUDE.md "Storage
 * rules") — `OBJECT_STORAGE_PROVIDER` is declared in
 * `lib/validation/env.server.ts` but nothing reads it yet, since no vendor
 * has been selected. `MemoryStorageProvider` is used as the default in the
 * meantime — its own doc comment anticipates exactly this: "any future
 * local development without a real bucket configured". This is what lets
 * Phase 3's generation pipeline (services/generation/) exercise real
 * upload/reference-storage plumbing end-to-end (in tests and local dev)
 * without depending on a chosen bucket/vendor.
 *
 * A single process-wide instance (not a fresh one per call) so uploads and
 * reads within the same process see the same objects — this matters for
 * `MemoryStorageProvider`, which holds objects in an in-process `Map`, not
 * on a network peer any process can reach; it will NOT be shared across
 * process boundaries (e.g. the web server vs. the `workers/` process).
 * That's an accepted limitation of using it as a placeholder — see
 * docs/generation.md "Storage" — and stops applying automatically once a
 * real vendor is selected here.
 */
import type { StorageProvider } from "./types";
import { MemoryStorageProvider } from "./memory-provider";

let provider: StorageProvider | undefined;

export function getConfiguredStorageProvider(): StorageProvider {
  if (!provider) {
    // No real vendor selected — see module doc comment above. When one is
    // added, branch on `getEnv().OBJECT_STORAGE_PROVIDER` here; this is the
    // only place that needs to change.
    provider = new MemoryStorageProvider();
  }
  return provider;
}

/** Test-only: forces a fresh provider instance so one test's uploaded
 * objects can't leak into another's assertions. */
export function resetConfiguredStorageProviderForTests(): void {
  provider = undefined;
}
