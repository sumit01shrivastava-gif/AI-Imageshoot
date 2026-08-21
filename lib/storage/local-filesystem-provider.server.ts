/**
 * Persistent, filesystem-backed `StorageProvider` — Phase 4's replacement
 * for `MemoryStorageProvider` as the default (see
 * docs/image-processing.md "Storage" for the full reasoning).
 *
 * Genuinely persistent (survives a process restart, and — unlike an
 * in-process `Map` — is shared across the web server and `workers/`
 * process boundary as long as they run on the same host with the same
 * `STORAGE_LOCAL_ROOT`, which is true of this app's deployment today).
 * Not a cloud object store: a future phase can add a real S3/R2/GCS
 * `StorageProvider` behind this exact same interface — `lib/storage/
 * provider.server.ts` is the only place that would need to change.
 *
 * `getSignedUrl` does NOT return a time-limited pre-signed cloud URL (there
 * is no cloud vendor) — it returns a `/media/<key>` path carrying an HMAC
 * signature + expiry that `app/routes/media.$.tsx` verifies itself,
 * independent of Shopify's session-token auth (which a plain `<img src>`
 * tag can't carry) — see that route's doc comment and
 * docs/image-processing.md "Storage".
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { DownloadResult, SignedUrlOptions, StorageProvider, UploadInput, UploadResult } from "./types";
import { getEnv } from "../validation/env.server";

/** Resolves the configured root, absolute, once per call (cheap — no I/O)
 * so `resetConfiguredStorageProviderForTests` + a changed env between
 * tests picks up a fresh root without restarting the process. */
function resolveRoot(): string {
  return path.resolve(process.cwd(), getEnv().STORAGE_LOCAL_ROOT);
}

/** Rejects a key that would escape the storage root once resolved — a
 * `key` reaching this class always comes from server-constructed paths
 * (`shops/{shop}/...`, see services/*.job.server.ts), never raw user
 * input, but this is defense in depth regardless (see CLAUDE.md "Security
 * requirements"). */
function resolveObjectPath(key: string): string {
  const root = resolveRoot();
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to access a storage key outside the configured root: "${key}"`);
  }
  return resolved;
}

/** Sidecar metadata file — filesystems don't carry a content-type
 * alongside bytes the way an object store does, so this stores the one
 * piece `download()` needs to reconstruct `DownloadResult.contentType`. */
function metadataPath(objectPath: string): string {
  return `${objectPath}.meta.json`;
}

function signingSecret(): string {
  const env = getEnv();
  return env.MEDIA_SIGNING_SECRET ?? `media-signing-fallback:${env.SHOPIFY_API_SECRET}`;
}

function signKeyAndExpiry(key: string, expiresAt: number): string {
  return createHmac("sha256", signingSecret()).update(`${key}:${expiresAt}`).digest("hex");
}

/** Verifies a media URL's `sig`/`expires` query params — used by
 * app/routes/app.media.$.tsx. Returns whether the signature is valid AND
 * unexpired; never throws. */
export function verifyMediaUrlSignature(key: string, expiresParam: string | null, sigParam: string | null): boolean {
  if (!expiresParam || !sigParam) return false;
  const expiresAt = Number(expiresParam);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expectedHex = signKeyAndExpiry(key, expiresAt);
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(sigParam, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export class LocalFilesystemStorageProvider implements StorageProvider {
  readonly name = "local-filesystem";

  async upload(input: UploadInput): Promise<UploadResult> {
    const objectPath = resolveObjectPath(input.key);
    await mkdir(path.dirname(objectPath), { recursive: true });
    const body = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    await writeFile(objectPath, body);
    await writeFile(metadataPath(objectPath), JSON.stringify({ contentType: input.contentType }));
    return { key: input.key, size: body.byteLength };
  }

  async download(key: string): Promise<DownloadResult> {
    const objectPath = resolveObjectPath(key);
    let body: Buffer;
    try {
      body = await readFile(objectPath);
    } catch {
      throw new Error(`LocalFilesystemStorageProvider: no object at key "${key}"`);
    }
    let contentType = "application/octet-stream";
    try {
      const meta = JSON.parse(await readFile(metadataPath(objectPath), "utf-8")) as { contentType?: string };
      contentType = meta.contentType ?? contentType;
    } catch {
      // No sidecar (or unreadable) — fall back to the generic content type
      // rather than failing the whole download over missing metadata.
    }
    return { key, body: new Uint8Array(body), contentType };
  }

  async delete(key: string): Promise<void> {
    const objectPath = resolveObjectPath(key);
    await rm(objectPath, { force: true });
    await rm(metadataPath(objectPath), { force: true });
  }

  async getSignedUrl(options: SignedUrlOptions): Promise<string> {
    if (options.operation === "put") {
      // Nothing in this app uploads directly from the browser yet — every
      // upload happens server-side, inside a queue job (see
      // services/generation/job.server.ts, services/processing/job.server.ts).
      throw new Error("LocalFilesystemStorageProvider does not support client-side direct upload ('put') yet.");
    }
    const expiresAt = Date.now() + options.expiresInSeconds * 1000;
    const signature = signKeyAndExpiry(options.key, expiresAt);
    // Encode each path segment individually (not the key as a whole) so
    // literal "/" characters survive as path separators — the media
    // route's splat param (`media.$.tsx`, `params["*"]`) reassembles them
    // back into the exact original key.
    const encodedKey = options.key.split("/").map(encodeURIComponent).join("/");
    return `/media/${encodedKey}?expires=${expiresAt}&sig=${signature}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(resolveObjectPath(key));
      return true;
    } catch {
      return false;
    }
  }

  /** @deprecated Use `exists` (the `StorageProvider` interface method) —
   * kept as an alias so any existing test-only caller of the old
   * debug-helper name keeps working. */
  async has(key: string): Promise<boolean> {
    return this.exists(key);
  }
}
