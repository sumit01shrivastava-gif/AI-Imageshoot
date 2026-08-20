/**
 * Resolves which `StorageProvider` the app uses.
 *
 * No real cloud storage vendor SDK is installed yet (see CLAUDE.md
 * "Storage rules"; `OBJECT_STORAGE_PROVIDER` is declared in
 * `lib/validation/env.server.ts` but unread). Phase 4 replaced the
 * previous default (`MemoryStorageProvider` — not actually persistent,
 * not shared across processes) with `LocalFilesystemStorageProvider` —
 * see that file's doc comment and docs/image-processing.md "Storage" for
 * why this satisfies "persistent storage" without a cloud vendor. A real
 * cloud provider, when selected, is the only thing that changes here.
 */
import type { StorageProvider } from "./types";
import { LocalFilesystemStorageProvider } from "./local-filesystem-provider.server";

let provider: StorageProvider | undefined;

export function getConfiguredStorageProvider(): StorageProvider {
  if (!provider) {
    // No real cloud vendor selected — see module doc comment above. When
    // one is added, branch on `getEnv().OBJECT_STORAGE_PROVIDER` here;
    // this is the only place that needs to change.
    provider = new LocalFilesystemStorageProvider();
  }
  return provider;
}

/** Test-only: forces a fresh provider instance so one test's uploaded
 * objects can't leak into another's assertions. */
export function resetConfiguredStorageProviderForTests(): void {
  provider = undefined;
}
