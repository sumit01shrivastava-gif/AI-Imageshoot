/**
 * Provider-agnostic object storage abstraction.
 *
 * No business logic anywhere else in the app should import a specific
 * storage SDK (S3, R2, Cloudinary, ...) directly — everything goes through
 * this interface. The concrete provider is selected later (see
 * docs/architecture.md) and plugged in behind `StorageProvider`.
 */

export interface UploadInput {
  /** Storage key/path, e.g. "shops/{shop}/media/{id}.png". Caller decides layout. */
  key: string;
  /** Raw bytes to store. */
  body: Uint8Array | Buffer;
  /** MIME type of `body`. */
  contentType: string;
}

export interface UploadResult {
  key: string;
  /** Size in bytes, as recorded by the provider. */
  size: number;
}

export interface DownloadResult {
  key: string;
  body: Uint8Array;
  contentType: string;
}

export interface SignedUrlOptions {
  key: string;
  /** How long the URL remains valid, in seconds. */
  expiresInSeconds: number;
  /** "get" for read access, "put" for direct client upload. */
  operation: "get" | "put";
}

export interface StorageProvider {
  readonly name: string;
  upload(input: UploadInput): Promise<UploadResult>;
  download(key: string): Promise<DownloadResult>;
  delete(key: string): Promise<void>;
  getSignedUrl(options: SignedUrlOptions): Promise<string>;
  /** Whether an object currently exists at `key` — never throws for a
   * missing object (that's a normal `false`, not an error); a genuine
   * provider/network failure still propagates. Used for orphaned-object
   * cleanup (see lib/storage/cleanup.server.ts) and safe deletes that
   * shouldn't fail just because the object was already gone. */
  exists(key: string): Promise<boolean>;
}
