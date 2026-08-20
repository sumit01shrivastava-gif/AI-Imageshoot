/**
 * Pure mapping: our synced `ShopifyProduct` (+ media) → the
 * `AnalyzeProductInput` an `AIProvider.analyzeProduct` call is grounded in.
 * No I/O — unit tested directly.
 */
import type { ProductDetail } from "../../db/repositories/shopify-product.repository";
import type { AnalyzeProductInput, ProductImageReference } from "../ai/types";

export function buildAnalyzeProductInput(product: ProductDetail): AnalyzeProductInput {
  const images: ProductImageReference[] = product.media.map((media) => ({
    mediaId: media.id,
    // Prefer the full-resolution image — a provider deciding it only needs
    // a smaller version is its own concern, not something we pre-decide.
    url: media.originalUrl,
    altText: media.altText,
    position: media.position,
  }));

  return {
    title: product.title,
    description: product.description,
    productType: product.productType,
    category: product.category,
    vendor: product.vendor,
    tags: product.tags,
    images,
  };
}
