/**
 * BullMQ job payload + processor for the `"publishing"` queue (reserved
 * in lib/queue/names.ts since Phase 0, unregistered until this pass).
 *
 * Mirrors every other domain's job.server.ts shape (idempotency guard
 * checked before `markProcessing`, same terminal-state/retry pattern —
 * see services/generation/job.server.ts's module doc comment for the
 * full reasoning, which applies unchanged here) with one addition: a
 * `ShopifyPublishError` whose `isPermissionError` is `true` (this app
 * currently has no `write_products` scope — see
 * services/shopify/publish-media.server.ts's doc comment) is wrapped in
 * BullMQ's `UnrecoverableError`, skipping further retries — "retry only
 * where semantically safe" (a missing scope will not fix itself between
 * backoff attempts, so retrying just delays the merchant-visible FAILED
 * state for no benefit).
 */
import type { Processor } from "bullmq";
import { UnrecoverableError } from "bullmq";
import { buildJobId } from "../../lib/queue/job-id";
import { logger } from "../../lib/logging/logger.server";
import { getConfiguredStorageProvider } from "../../lib/storage";
import type { AuthContext } from "../../lib/auth/types";
import {
  getPublishingJob,
  markProcessing,
  markSucceeded,
  markFailed,
} from "../../db/repositories/publishing-job.repository";
import { resolvePublishSource } from "./resolve-source.server";
import { publishMediaToProduct, ShopifyPublishError } from "../shopify/publish-media.server";

export interface PublishingJobPayload {
  shop: string;
  publishingJobId: string;
}

export function publishingBullJobId(payload: PublishingJobPayload): string {
  return buildJobId("publishing", payload.shop, payload.publishingJobId);
}

const GENERIC_FAILURE_MESSAGE = "Publishing failed. Please try again in a moment.";
const NOT_APPROVED_MESSAGE = "This result is no longer approved for publishing.";
const SOURCE_GONE_MESSAGE = "The result being published no longer exists.";
const PERMISSION_MESSAGE =
  "This app doesn't have permission to publish images to your store yet. Contact the app developer.";

const SIGNED_URL_TTL_SECONDS = 3600;

export const processPublishingJob: Processor<PublishingJobPayload> = async (job) => {
  const { shop, publishingJobId } = job.data;
  const attempt = job.attemptsMade + 1;
  const totalAttempts = job.opts.attempts ?? 1;

  logger.info("publishing.job.start", { shop, publishingJobId, attempt, totalAttempts });

  const context: AuthContext = { shop, sessionId: "worker:publishing", isOnline: false };

  // Idempotency guard — checked BEFORE markProcessing (see
  // services/generation/job.server.ts's identical guard/ordering
  // reasoning — a real, once-caught bug there: markProcessing
  // unconditionally overwrites status, so the guard must run first).
  const existingJobRow = await getPublishingJob(context, publishingJobId);
  if (existingJobRow?.status === "SUCCEEDED") {
    logger.info("publishing.job.already_succeeded", { shop, publishingJobId, attempt });
    return;
  }

  await markProcessing(shop, publishingJobId, attempt);

  const attemptStartedAt = Date.now();

  try {
    const jobRow = await getPublishingJob(context, publishingJobId);
    if (!jobRow) {
      logger.warn("publishing.job.missing_row", { shop, publishingJobId });
      return;
    }

    // Re-resolve the source fresh — never trust anything from request
    // time. A result can be un-approved/rejected, or the product can be
    // removed by catalog sync, between the publish request and this job
    // actually running.
    const source = await resolvePublishSource(context, jobRow.sourceType, jobRow.sourceResultId);
    if (!source) {
      const durationMs = Date.now() - attemptStartedAt;
      await markFailed(shop, publishingJobId, { message: SOURCE_GONE_MESSAGE, durationMs });
      return;
    }
    if (source.reviewStatus !== "APPROVED") {
      const durationMs = Date.now() - attemptStartedAt;
      await markFailed(shop, publishingJobId, { message: NOT_APPROVED_MESSAGE, durationMs });
      return;
    }
    const target = source.candidateProducts.find((p) => p.productId === jobRow.targetProductId);
    if (!target) {
      const durationMs = Date.now() - attemptStartedAt;
      await markFailed(shop, publishingJobId, { message: SOURCE_GONE_MESSAGE, durationMs });
      return;
    }

    const storage = getConfiguredStorageProvider();
    const imageUrl = await storage.getSignedUrl({
      key: source.storageKey,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      operation: "get",
    });

    const { shopifyMediaId } = await publishMediaToProduct(shop, {
      shopifyProductId: target.shopifyProductId,
      imageUrl,
      altText: target.title,
    });

    const durationMs = Date.now() - attemptStartedAt;
    await markSucceeded(shop, publishingJobId, { shopifyMediaId, durationMs });

    logger.info("publishing.job.completed", { shop, publishingJobId, shopifyMediaId, durationMs });
  } catch (error) {
    const durationMs = Date.now() - attemptStartedAt;
    const isFinalAttempt = attempt >= totalAttempts;
    const isPermissionError = error instanceof ShopifyPublishError && error.isPermissionError;

    logger.error("publishing.job.attempt_failed", {
      shop,
      publishingJobId,
      attempt,
      totalAttempts,
      isFinalAttempt,
      isPermissionError,
      detail: error instanceof Error ? error.message : "unknown error",
    });

    if (isFinalAttempt || isPermissionError) {
      const message = isPermissionError ? PERMISSION_MESSAGE : GENERIC_FAILURE_MESSAGE;
      await markFailed(shop, publishingJobId, { message, durationMs });
    }

    // A permission error will not resolve itself on retry (the scope
    // isn't going to change mid-backoff) — skip straight to final
    // failure via BullMQ's own UnrecoverableError rather than burning
    // through attempts/backoff pointlessly. Every other error keeps the
    // normal retry behavior.
    if (isPermissionError) {
      throw new UnrecoverableError(error instanceof Error ? error.message : "Publish permission error");
    }
    throw error;
  }
};
