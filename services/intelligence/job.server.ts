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
import { recordUsageEvent } from "../usage/usage-accounting.server";
import { settleReservation, refundReservation } from "../../db/repositories/credit-reservation.repository";

export interface ProductIntelligenceJobPayload {
  shop: string;
  /** Our internal `ShopifyProduct.id` (not the Shopify GraphQL id). */
  productId: string;
  /** The `CreditReservation.jobId` this specific request reserved credits
   * against (see product-intelligence.server.ts's `requestProductAnalysis`)
   * — a synthetic per-REQUEST id, deliberately NOT `productId`/this
   * queue's own deterministic job id (both are reused across repeat
   * analyses, which would make every re-analysis collide with — and
   * silently no-op against — the first request's reservation). Absent
   * when the request was recognized as a duplicate collapsing onto an
   * already-in-flight job (nothing to settle/refund in that case — the
   * ORIGINAL request's reservation is what resolves). */
  creditReservationId?: string;
}

export function productIntelligenceJobId(payload: ProductIntelligenceJobPayload): string {
  return buildJobId("product-intelligence", payload.shop, payload.productId);
}

const GENERIC_ANALYSIS_FAILURE_MESSAGE = "Analysis failed. Please try analyzing again in a moment.";
const NOT_CONFIGURED_MESSAGE = "AI analysis isn't configured for this store yet.";
const INVALID_OUTPUT_MESSAGE = "The AI analysis returned an unexpected result. Please try again.";

/** Best-effort settle/refund — never allowed to fail the job itself, same
 * reasoning as every other domain's credit-resolution helper. A no-op
 * when `creditReservationId` is absent (a collapsed-duplicate request —
 * see `ProductIntelligenceJobPayload`'s doc comment). */
async function resolveAnalysisCredits(shop: string, creditReservationId: string | undefined, outcome: "SUCCEEDED" | "FAILED"): Promise<void> {
  if (!creditReservationId) return;
  try {
    if (outcome === "SUCCEEDED") {
      await settleReservation(shop, creditReservationId);
    } else {
      await refundReservation(shop, creditReservationId);
    }
  } catch (error) {
    logger.warn("intelligence.job.credit_resolution_failed", {
      shop,
      creditReservationId,
      detail: error instanceof Error ? error.message : "unknown error",
    });
  }
}

export const processProductIntelligenceJob: Processor<ProductIntelligenceJobPayload> = async (job) => {
  const { shop, productId, creditReservationId } = job.data;
  logger.info("intelligence.job.start", { shop, productId });

  await markProcessing(shop, productId);

  // The job payload is server-derived (this queue is only ever fed by
  // services/intelligence/product-intelligence.server.ts's
  // `requestProductAnalysis`, itself gated on a verified AuthContext) —
  // but we still route through the same shop-ownership-checked repository
  // function request-scoped code uses, as defense in depth. See CLAUDE.md
  // "Security requirements".
  const context: AuthContext = { shop, sessionId: "worker:product-intelligence", isOnline: false };
  const startedAt = Date.now();
  // This domain has no persisted per-request job row (a `ProductIntelligence`
  // profile is upserted, one row per product — see docs/product-intelligence.md
  // "Lifecycle") — the BullMQ job's own id is the closest stable, unique
  // -per-run identifier to key the usage ledger's idempotency on. Falls
  // back to a synthetic id in the (practically unreachable) case `job.id`
  // is unset.
  const usageJobId = job.id ?? `${productId}:${startedAt}`;

  try {
    const product = await findProductForShop(context, productId);
    if (!product) {
      // Product was deleted (by catalog sync) between the analysis being
      // requested and this job running.
      // Usage/credit bookkeeping before the terminal status write — see
      // services/generation/job.server.ts's identical reordering/
      // reasoning (a caller polling job status must never observe a
      // terminal FAILED status before the reservation has actually been
      // refunded). Safe here specifically because `markFailed` is a
      // dedicated status-only write, independent of any data this
      // request would have produced — unlike the SUCCEEDED path below,
      // whose `saveResult` atomically writes both the analysis data AND
      // the READY status in one upsert, so reordering credit settlement
      // ahead of IT would risk settling a credit for a write that then
      // fails (see that call site's own doc comment).
      await recordProductAnalysisUsage(shop, usageJobId, "FAILED", { durationMs: Date.now() - startedAt });
      await resolveAnalysisCredits(shop, creditReservationId, "FAILED");
      await markFailed(shop, productId, "This product no longer exists.");
      return;
    }

    const input = buildAnalyzeProductInput(product);
    const provider = getConfiguredAIProvider();
    const raw = await provider.analyzeProduct(input);
    const data = parseProductIntelligenceOutput(raw);

    // Deliberately NOT reordered to settle credits first (unlike every
    // other domain's job.server.ts — see the FAILED branches' doc
    // comments below): `saveResult` atomically upserts both the analysis
    // data AND the READY status in one write. Settling credits ahead of
    // it would mean a `saveResult` failure leaves the reservation already
    // CONSUMED (a conditional update, so `resolveAnalysisCredits`'s later
    // refund attempt in the catch block below would be a no-op against
    // an already-CONSUMED row) even though no analysis was ever actually
    // saved — a worse bug (a charged credit for nothing delivered) than
    // the narrower read-only race this ordering accepts instead (a
    // caller could observe READY status a moment before the reservation
    // shows CONSUMED).
    await saveResult(shop, productId, data, {
      providerName: provider.name,
      sourceShopifyUpdatedAt: product.shopifyUpdatedAt,
      rawAnalysis: raw,
    });
    await recordProductAnalysisUsage(shop, usageJobId, "SUCCEEDED", {
      providerName: provider.name,
      durationMs: Date.now() - startedAt,
    });
    await resolveAnalysisCredits(shop, creditReservationId, "SUCCEEDED");

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
    // Usage/credit bookkeeping before the terminal status write — see the
    // early-return FAILED path above for the full reasoning.
    await recordProductAnalysisUsage(shop, usageJobId, "FAILED", { durationMs: Date.now() - startedAt });
    await resolveAnalysisCredits(shop, creditReservationId, "FAILED");
    await markFailed(shop, productId, message);
    throw error;
  }
};

/** See services/generation/job.server.ts's identical helper — records
 * this job's terminal outcome onto the usage ledger; a ledger write
 * failure is logged and swallowed, never allowed to fail the job. */
async function recordProductAnalysisUsage(
  shop: string,
  jobId: string,
  status: "SUCCEEDED" | "FAILED",
  detail: { providerName?: string; durationMs?: number },
): Promise<void> {
  try {
    await recordUsageEvent({
      shop,
      operationType: "PRODUCT_ANALYSIS",
      status,
      jobId,
      providerName: detail.providerName ?? null,
      outputCount: status === "SUCCEEDED" ? 1 : 0,
      durationMs: detail.durationMs ?? null,
    });
  } catch (error) {
    logger.warn("intelligence.job.usage_record_failed", {
      shop,
      jobId,
      detail: error instanceof Error ? error.message : "unknown error",
    });
  }
}
