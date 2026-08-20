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

function toImageReference(media: { id: string; originalUrl: string; altText: string | null; position: number }): ProductImageReference {
  return { mediaId: media.id, url: media.originalUrl, altText: media.altText, position: media.position };
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

  await markProcessing(shop, processingJobId, attempt);

  const context: AuthContext = { shop, sessionId: "worker:processing", isOnline: false };
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
      await markFailed(shop, processingJobId, {
        message: "The source image no longer exists.",
        durationMs: Date.now() - attemptStartedAt,
      });
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

    const durationMs = Date.now() - attemptStartedAt;
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
      await markFailed(shop, processingJobId, { message, durationMs });
    }

    // Rethrow regardless — this is what tells BullMQ the attempt failed,
    // so it schedules the next retry (or gives up, if this was final).
    throw error;
  }
};
