/**
 * In-memory StorageProvider.
 *
 * Not for production use. Exists so unit tests (and any future local
 * development without a real bucket configured) can exercise storage-shaped
 * code paths without hitting a network or requiring a chosen provider.
 */
import type { DownloadResult, SignedUrlOptions, StorageProvider, UploadInput, UploadResult } from "./types";

export class MemoryStorageProvider implements StorageProvider {
  readonly name = "memory";
  private readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async upload(input: UploadInput): Promise<UploadResult> {
    const body = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
    this.objects.set(input.key, { body, contentType: input.contentType });
    return { key: input.key, size: body.byteLength };
  }

  async download(key: string): Promise<DownloadResult> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`MemoryStorageProvider: no object at key "${key}"`);
    }
    return { key, body: object.body, contentType: object.contentType };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async getSignedUrl(options: SignedUrlOptions): Promise<string> {
    return `memory://${options.key}?operation=${options.operation}&expiresIn=${options.expiresInSeconds}`;
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  /** @deprecated Synchronous test helper predating the `StorageProvider`
   * interface's own `exists`. Use `exists` for anything typed against the
   * interface; kept for any existing synchronous test call site. */
  has(key: string): boolean {
    return this.objects.has(key);
  }
}
