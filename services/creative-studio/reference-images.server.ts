/**
 * Uploads a standalone Creative Studio session's freshly attached
 * reference images through the existing StorageProvider abstraction — the
 * same "never keep raw bytes past the point they're persisted" pattern
 * services/generation/job.server.ts's `persistOutput` already uses for
 * generated OUTPUTS, applied here to merchant-uploaded INPUTS.
 *
 * A standalone (no Shopify product) session has no ShopifyProductMedia to
 * reference — see prisma/schema.prisma's CreativeSession.productId
 * comment — so an uploaded photo IS this turn's source image; it needs a
 * real, durable URL before it can be included in a `GenerationPlan`'s
 * `referenceImages` or passed to an `ImageGenerationProvider`. Only ever
 * called for a standalone session (services/creative-studio/session.server.ts):
 * a Shopify-context session already has real product media to ground
 * against and never calls this.
 */
import { getConfiguredStorageProvider } from "../../lib/storage";

export interface UploadedReferenceImageInput {
  data: Uint8Array;
  contentType: string;
}

function extensionFromContentType(contentType: string): string {
  const match = /^image\/(\w+)/.exec(contentType);
  return match?.[1] ?? "bin";
}

/**
 * Uploads every image attached to this turn, returning fresh, fetchable
 * URLs in the same order. Empty input returns an empty array without
 * touching storage at all — the common case (most turns have no fresh
 * attachment). Every upload runs in parallel and either all succeed or
 * the whole call rejects (a message that silently lost one of several
 * attached photos would be worse than a clear failure) — this always
 * runs BEFORE any credit is reserved or `GenerationJob` created, so a
 * rejection here simply fails the request with nothing left to roll
 * back.
 */
export async function uploadReferenceImages(
  shop: string,
  creativeSessionId: string,
  images: UploadedReferenceImageInput[],
): Promise<string[]> {
  if (images.length === 0) return [];

  const storage = getConfiguredStorageProvider();
  const uploadedAt = Date.now();

  return Promise.all(
    images.map(async (image, index) => {
      const key = `shops/${shop}/creative-uploads/${creativeSessionId}/${uploadedAt}-${index}.${extensionFromContentType(image.contentType)}`;
      const uploaded = await storage.upload({ key, body: image.data, contentType: image.contentType });
      return storage.getSignedUrl({ key: uploaded.key, expiresInSeconds: 3600, operation: "get" });
    }),
  );
}
