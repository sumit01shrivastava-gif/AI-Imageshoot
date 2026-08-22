/**
 * BullMQ job payload + processor for the `"enhancement"` queue (see
 * lib/queue/names.ts — reserved since Phase 0 for exactly this: "background
 * removal / cleanup / upscale jobs").
 *
 * Job-id and retry semantics mirror services/generation/job.server.ts,
 * for the same reason: a merchant must be able to re-request processing
 * (Regenerate) any number of times, each an independent, preserved
 * result — so this hashes `(shop, processingJobId)`, not `(shop,
 * productId)`, and the queue sets automatic-retry `attempts`/`backoff`
 * (see queue.server.ts). See docs/image-processing.md "Processing
 * lifecycle" and "Retry behavior".
 */
import type { Processor } from "bullmq";
import { buildJobId } from "../../lib/queue/job-id";
import { logger } from "../../lib/logging/logger.server";
import { getConfiguredStorageProvider } from "../../lib/storage";
import type { AuthContext } from "../../lib/auth/types";
import {
  getProcessingJob,
  markProcessing,
  markSucceeded,
  markFailed,
  createResult,
} from "../../db/repositories/processing-job.repository";
import { findMediaForProduct } from "../../db/repositories/shopify-product.repository";
import { buildImageProcessingInput } from "./build-input";
import { getConfiguredImageProcessingProvider } from "./provider.server";
import { parseProcessingOptions, assertValidProcessingOutput, InvalidProcessingOutputError } from "./schema";
import { UnconfiguredAIProviderError } from "../ai/unconfigured-provider";
import type { ImageProcessingOutput, ImageProcessingProvider, ProductImageReference } from "../ai/types";
import { recordUsageEvent } from "../usage/usage-accounting.server";
import { settleReservation, refundReservation } from "../../db/repositories/credit-reservation.repository";

function toImageReference(media: { id: string; originalUrl: string; altText: string | null; position: number }): ProductImageReference {
  return { mediaId: media.id, url: media.originalUrl, altText: media.altText, position: media.position };
}

/** See services/generation/job.server.ts's identical helper — records
 * this job's terminal outcome onto the usage ledger; a ledger write
 * failure is logged and swallowed, never allowed to fail the job. */
async function recordProcessingUsage(
  shop: string,
  processingJobId: string,
  status: "SUCCEEDED" | "FAILED",
  detail: { providerName?: string; durationMs?: number },
): Promise<void> {
  try {
    await recordUsageEvent({
      shop,
      operationType: "IMAGE_PROCESSING",
      status,
      jobId: processingJobId,
      providerName: detail.providerName ?? null,
      outputCount: status === "SUCCEEDED" ? 1 : 0,
      durationMs: detail.durationMs ?? null,
    });
  } catch (error) {
    logger.warn("processing.job.usage_record_failed", {
      shop,
      processingJobId,
      detail: error instanceof Error ? error.message : "unknown error",
    });
  }
}

export interface ProcessingJobPayload {
  shop: string;
  /** Our internal `ProcessingJob.id`. */
  processingJobId: string;
}

export function processingBullJobId(payload: ProcessingJobPayload): string {
  return buildJobId("processing", payload.shop, payload.processingJobId);
}

const GENERIC_FAILURE_MESSAGE = "Processing failed. Please try again in a moment.";
const NOT_CONFIGURED_MESSAGE = "This processing operation isn't configured for this store yet.";
const INVALID_OUTPUT_MESSAGE = "The processing provider returned an unexpected result. Please try again.";

function formatFromContentType(contentType: string): string | null {
  const match = /^image\/(\w+)/.exec(contentType);
  return match?.[1] ?? null;
}

async function callOperation(
  provider: ImageProcessingProvider,
  operation: string,
  sourceImage: ProductImageReference,
  options: Record<string, unknown>,
): Promise<ImageProcessingOutput> {
  const input = buildImageProcessingInput(sourceImage, options);
  switch (operation) {
    case "REMOVE_BACKGROUND":
      return provider.removeBackground(input);
    case "ENHANCE":
      return provider.enhance(input);
    case "RESIZE":
      return provider.resize(input);
    case "UPSCALE":
      return provider.upscale(input);
    case "GENERATE_SHADOW":
      return provider.generateShadow(input);
    case "CROP":
      return provider.crop(input);
    default:
      // Unreachable given ImageOperationSchema validation upstream — kept
      // as an explicit, safe failure rather than a silent fallthrough.
      throw new Error(`Unknown image operation: "${operation}"`);
  }
}

export const processProcessingJob: Processor<ProcessingJobPayload> = async (job) => {
  const { shop, processingJobId } = job.data;
  const attempt = job.attemptsMade + 1;
  const totalAttempts = job.opts.attempts ?? 1;

  logger.info("processing.job.start", { shop, processingJobId, attempt, totalAttempts });

  const context: AuthContext = { shop, sessionId: "worker:processing", isOnline: false };

  // Idempotency guard — checked BEFORE `markProcessing` (which
  // unconditionally overwrites `status`, so checking after it would
  // never see "SUCCEEDED"). See services/generation/job.server.ts's
  // identical guard for the full reasoning (a redelivered/duplicate
  // BullMQ job, or a prior attempt that persisted a result and then
  // failed writing SUCCEEDED itself, would otherwise create a second
  // result for the same logical request).
  const existingJobRow = await getProcessingJob(context, processingJobId);
  if (existingJobRow?.status === "SUCCEEDED") {
    logger.info("processing.job.already_succeeded", { shop, processingJobId, attempt });
    return;
  }

  await markProcessing(shop, processingJobId, attempt);

  const attemptStartedAt = Date.now();

  try {
    const jobRow = await getProcessingJob(context, processingJobId);
    if (!jobRow) {
      // Row is gone (e.g. the product/media was deleted, cascading it
      // away) between enqueue and processing — nothing to do.
      logger.warn("processing.job.missing_row", { shop, processingJobId });
      return;
    }

    const sourceMedia = await findMediaForProduct(shop, jobRow.productId, jobRow.sourceMediaId);
    if (!sourceMedia) {
      const durationMs = Date.now() - attemptStartedAt;
      // This is a genuine terminal failure (no retry will fix a deleted
      // source image) — recorded immediately, not gated on
      // isFinalAttempt the way the catch block below is, since there IS
      // no further attempt coming for this specific failure. Usage/credit
      // bookkeeping before the terminal status write — see the SUCCEEDED
      // path's identical reordering/reasoning below.
      await recordProcessingUsage(shop, processingJobId, "FAILED", { durationMs });
      await refundReservation(shop, processingJobId).catch((refundError: unknown) =>
        logger.warn("processing.job.credit_resolution_failed", {
          shop,
          processingJobId,
          detail: refundError instanceof Error ? refundError.message : "unknown error",
        }),
      );
      await markFailed(shop, processingJobId, { message: "The source image no longer exists.", durationMs });
      return;
    }

    const options = parseProcessingOptions(jobRow.options);
    const provider = getConfiguredImageProcessingProvider();
    const output = await callOperation(provider, jobRow.operation, toImageReference(sourceMedia), options);
    assertValidProcessingOutput(output);

    const format = formatFromContentType(output.contentType) ?? "bin";
    const key = `shops/${shop}/processing/${processingJobId}/0.${format}`;
    const storage = getConfiguredStorageProvider();
    const uploaded = await storage.upload({ key, body: output.data, contentType: output.contentType });
    const url = await storage.getSignedUrl({ key: uploaded.key, expiresInSeconds: 3600, operation: "get" });

    try {
      await createResult(shop, processingJobId, {
        storageKey: uploaded.key,
        url,
        width: output.width ?? null,
        height: output.height ?? null,
        format: formatFromContentType(output.contentType),
        providerName: provider.name,
        providerResultId: (output.metadata?.providerResultId as string | undefined) ?? null,
        metadata: output.metadata ?? null,
      });
    } catch (persistError) {
      // See services/generation/job.server.ts's identical cleanup for
      // the full reasoning — the upload succeeded but the DB write that
      // would make it referenced didn't; delete the now-orphaned object
      // rather than leaving it unreferenced forever. Best-effort.
      await storage.delete(uploaded.key).catch((cleanupError: unknown) =>
        logger.warn("processing.job.orphan_cleanup_failed", {
          shop,
          processingJobId,
          storageKey: uploaded.key,
          detail: cleanupError instanceof Error ? cleanupError.message : "unknown error",
        }),
      );
      throw persistError;
    }

    const durationMs = Date.now() - attemptStartedAt;
    // Usage/credit bookkeeping runs BEFORE `markSucceeded` writes the
    // terminal status — see services/generation/job.server.ts's
    // identical reordering/reasoning (a genuine, empirically-reproduced
    // race under load: a caller polling job status must never observe
    // SUCCEEDED before the reservation has actually settled).
    await recordProcessingUsage(shop, processingJobId, "SUCCEEDED", { providerName: provider.name, durationMs });
    await settleReservation(shop, processingJobId).catch((settleError: unknown) =>
      logger.warn("processing.job.credit_resolution_failed", {
        shop,
        processingJobId,
        detail: settleError instanceof Error ? settleError.message : "unknown error",
      }),
    );
    await markSucceeded(shop, processingJobId, { providerName: provider.name, durationMs });

    logger.info("processing.job.completed", {
      shop,
      processingJobId,
      operation: jobRow.operation,
      providerName: provider.name,
      durationMs,
    });
  } catch (error) {
    const durationMs = Date.now() - attemptStartedAt;
    const isFinalAttempt = attempt >= totalAttempts;

    logger.error("processing.job.attempt_failed", {
      shop,
      processingJobId,
      attempt,
      totalAttempts,
      isFinalAttempt,
      detail: error instanceof Error ? error.message : "unknown error",
    });

    if (isFinalAttempt) {
      const message =
        error instanceof UnconfiguredAIProviderError
          ? NOT_CONFIGURED_MESSAGE
          : error instanceof InvalidProcessingOutputError
            ? INVALID_OUTPUT_MESSAGE
            : GENERIC_FAILURE_MESSAGE;
      // Same "usage/credit bookkeeping before the terminal status write"
      // reordering as the SUCCEEDED path above.
      await recordProcessingUsage(shop, processingJobId, "FAILED", { durationMs });
      await refundReservation(shop, processingJobId).catch((refundError: unknown) =>
        logger.warn("processing.job.credit_resolution_failed", {
          shop,
          processingJobId,
          detail: refundError instanceof Error ? refundError.message : "unknown error",
        }),
      );
      await markFailed(shop, processingJobId, { message, durationMs });
    }

    // Rethrow regardless — this is what tells BullMQ the attempt failed,
    // so it schedules the next retry (or gives up, if this was final).
    throw error;
  }
};
