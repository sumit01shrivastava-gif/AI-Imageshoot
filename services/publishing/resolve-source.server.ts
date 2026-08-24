/**
 * Resolves a `PublishingSourceType` + result id into the normalized shape
 * services/publishing/request-publish.server.ts needs — the one place
 * that reaches across Generation/Processing/StoreVisual's three
 * independent result tables for publishing, mirroring
 * services/assets/asset-library.server.ts's identical "soft
 * cross-domain reference, resolved by a small per-domain repository
 * lookup" pattern (see that file's doc comment for the same reasoning
 * applied to the Asset Library's list view instead of a single lookup).
 */
import type { ReviewStatus } from "@prisma/client";
import type { AuthContext } from "../../lib/auth/types";
import { getGenerationResultForPublishing } from "../../db/repositories/generation-job.repository";
import { getProcessingResultForPublishing } from "../../db/repositories/processing-job.repository";
import { getStoreVisualResultForPublishing } from "../../db/repositories/store-visual-job.repository";
import type { PublishingSourceTypeValue } from "./types";

export interface PublishCandidateProduct {
  /** Our internal `ShopifyProduct.id`. */
  productId: string;
  /** Shopify's own GraphQL global id — what the publish mutation needs. */
  shopifyProductId: string;
  title: string;
}

export interface PublishSource {
  storageKey: string;
  reviewStatus: ReviewStatus;
  /** Candidate target products this result could be published to.
   * GENERATION/PROCESSING: always exactly one (its owning product).
   * STORE_VISUAL: zero (a fully generic visual — publishing isn't
   * available) to several (its featured products). */
  candidateProducts: PublishCandidateProduct[];
}

/** Returns `null` (never throws) for a missing or cross-shop result id —
 * the same safe "existence oracle" pattern every other domain in this
 * codebase uses; services/publishing/request-publish.server.ts maps that
 * to its own not-found error at the boundary. */
export async function resolvePublishSource(
  context: AuthContext,
  sourceType: PublishingSourceTypeValue,
  sourceResultId: string,
): Promise<PublishSource | null> {
  if (sourceType === "GENERATION_RESULT") {
    const row = await getGenerationResultForPublishing(context.shop, sourceResultId);
    if (!row) return null;
    return {
      storageKey: row.storageKey,
      reviewStatus: row.reviewStatus,
      // A standalone (no Shopify product) Creative Studio result has no
      // candidate product to publish to — the same "zero candidates" shape
      // STORE_VISUAL_RESULT already documents above (this interface's own
      // doc comment), never an error. See prisma/schema.prisma's
      // GenerationJob.productId comment.
      candidateProducts: row.generationJob.product
        ? [
            {
              productId: row.generationJob.product.id,
              shopifyProductId: row.generationJob.product.shopifyProductId,
              title: row.generationJob.product.title,
            },
          ]
        : [],
    };
  }

  if (sourceType === "PROCESSING_RESULT") {
    const row = await getProcessingResultForPublishing(context.shop, sourceResultId);
    if (!row) return null;
    return {
      storageKey: row.storageKey,
      reviewStatus: row.reviewStatus,
      candidateProducts: [
        {
          productId: row.processingJob.productId,
          shopifyProductId: row.processingJob.product.shopifyProductId,
          title: row.processingJob.product.title,
        },
      ],
    };
  }

  // STORE_VISUAL_RESULT
  const row = await getStoreVisualResultForPublishing(context.shop, sourceResultId);
  if (!row) return null;
  return {
    storageKey: row.storageKey,
    reviewStatus: row.reviewStatus,
    candidateProducts: row.storeVisualJob.products.map((ref) => ({
      productId: ref.productId,
      shopifyProductId: ref.product.shopifyProductId,
      title: ref.product.title,
    })),
  };
}
