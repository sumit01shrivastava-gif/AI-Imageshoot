/**
 * BullMQ job payload + processor for the `"product-intelligence"` queue.
 *
 * Mirrors services/products/sync-job.server.ts's shape deliberately — same
 * job-id/dedup semantics (see lib/queue/job-id.ts and
 * lib/queue/queue.server.ts's module doc comment: a finished job's id is
 * reusable, so re-analysis always gets a real job, not a silent no-op —
 * see the Phase 0/1 security audit for the bug this generalizes the fix
 * for), same idempotent-safe-upsert persistence pattern, same
 * generic-merchant-safe-error-on-failure pattern.
 */
import type { Processor } from "bullmq";
import { buildJobId } from "../../lib/queue/job-id";
import { logger } from "../../lib/logging/logger.server";
import type { AuthContext } from "../../lib/auth/types";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { markProcessing, markFailed, saveResult } from "../../db/repositories/product-intelligence.repository";
import { buildAnalyzeProductInput } from "./build-input";
import { getConfiguredAIProvider } from "./provider.server";
import { parseProductIntelligenceOutput, InvalidProductIntelligenceOutputError } from "./schema";
import { UnconfiguredAIProviderError } from "../ai/unconfigured-provider";

export interface ProductIntelligenceJobPayload {
  shop: string;
  /** Our internal `ShopifyProduct.id` (not the Shopify GraphQL id). */
  productId: string;
}

export function productIntelligenceJobId(payload: ProductIntelligenceJobPayload): string {
  return buildJobId("product-intelligence", payload.shop, payload.productId);
}

const GENERIC_ANALYSIS_FAILURE_MESSAGE = "Analysis failed. Please try analyzing again in a moment.";
const NOT_CONFIGURED_MESSAGE = "AI analysis isn't configured for this store yet.";
const INVALID_OUTPUT_MESSAGE = "The AI analysis returned an unexpected result. Please try again.";

export const processProductIntelligenceJob: Processor<ProductIntelligenceJobPayload> = async (job) => {
  const { shop, productId } = job.data;
  logger.info("intelligence.job.start", { shop, productId });

  await markProcessing(shop, productId);

  // The job payload is server-derived (this queue is only ever fed by
  // services/intelligence/product-intelligence.server.ts's
  // `requestProductAnalysis`, itself gated on a verified AuthContext) —
  // but we still route through the same shop-ownership-checked repository
  // function request-scoped code uses, as defense in depth. See CLAUDE.md
  // "Security requirements".
  const context: AuthContext = { shop, sessionId: "worker:product-intelligence", isOnline: false };

  try {
    const product = await findProductForShop(context, productId);
    if (!product) {
      // Product was deleted (by catalog sync) between the analysis being
      // requested and this job running.
      await markFailed(shop, productId, "This product no longer exists.");
      return;
    }

    const input = buildAnalyzeProductInput(product);
    const provider = getConfiguredAIProvider();
    const raw = await provider.analyzeProduct(input);
    const data = parseProductIntelligenceOutput(raw);

    await saveResult(shop, productId, data, {
      providerName: provider.name,
      sourceShopifyUpdatedAt: product.shopifyUpdatedAt,
      rawAnalysis: raw,
    });

    logger.info("intelligence.job.completed", { shop, productId, providerName: provider.name });
  } catch (error) {
    const message =
      error instanceof UnconfiguredAIProviderError
        ? NOT_CONFIGURED_MESSAGE
        : error instanceof InvalidProductIntelligenceOutputError
          ? INVALID_OUTPUT_MESSAGE
          : GENERIC_ANALYSIS_FAILURE_MESSAGE;

    logger.error("intelligence.job.failed", {
      shop,
      productId,
      detail: error instanceof Error ? error.message : "unknown error",
    });
    await markFailed(shop, productId, message);
    throw error;
  }
};
