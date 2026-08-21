/**
 * BullMQ job payload + processor for the `"generation"` queue.
 *
 * Job-id strategy is deliberately DIFFERENT from
 * services/intelligence/job.server.ts / services/products/sync-job.server.ts:
 * those hash `(shop, productId)` — stable/deterministic per product, so a
 * *repeat* request collapses onto the same in-flight work, which is
 * correct for "analyze"/"sync" (idempotent, one-current-result
 * operations). Generation is NOT that: a merchant must be able to
 * regenerate the same product any number of times, each a new,
 * independently-preserved result (see docs/generation.md "Generation
 * history") — so this hashes `(shop, generationJobId)`, and
 * `generationJobId` is already unique per request (a fresh row created by
 * `requestGeneration` every time — see product-intelligence.server.ts's
 * counterpart, request-generation.server.ts). There is no risk of a
 * regenerate ever colliding with a prior job's id, deterministic or not.
 *
 * Retry: unlike Phase 1/2's queues (no automatic BullMQ retry — a repeat
 * is always an explicit new request), this queue sets `attempts`/`backoff`
 * (see queue.server.ts) so a transient provider error gets retried
 * automatically before the merchant ever sees a FAILED status. The
 * `GenerationStatus` enum has no separate "RETRYING" state — the job stays
 * PROCESSING for the merchant's purposes across the whole retry sequence;
 * `errorMessage`/FAILED are only written once the FINAL attempt fails —
 * see the catch block below.
 */
import type { Processor } from "bullmq";
import { buildJobId } from "../../lib/queue/job-id";
import { logger } from "../../lib/logging/logger.server";
import { getConfiguredStorageProvider } from "../../lib/storage";
import type { AuthContext } from "../../lib/auth/types";
import {
  getGenerationJob,
  markProcessing,
  markSucceeded,
  markFailed,
  createResults,
  type CreateResultInput,
} from "../../db/repositories/generation-job.repository";
import { buildGenerateImageInput } from "./build-input";
import { getConfiguredImageGenerationProvider } from "./provider.server";
import { parseGenerationPlan, assertValidGenerateImageResult, InvalidGenerationResultError } from "./schema";
import { recordIdentityValidation, type IdentityValidationResult } from "./identity-validation.server";
import { UnconfiguredAIProviderError } from "../ai/unconfigured-provider";
import type { GeneratedImageOutput } from "../ai/types";

export interface GenerationJobPayload {
  shop: string;
  /** Our internal `GenerationJob.id` — see module doc comment for why this
   * (not productId) is what the BullMQ job id is built from. */
  generationJobId: string;
}

export function generationBullJobId(payload: GenerationJobPayload): string {
  return buildJobId("generation", payload.shop, payload.generationJobId);
}

const GENERIC_FAILURE_MESSAGE = "Generation failed. Please try again in a moment.";
const NOT_CONFIGURED_MESSAGE = "Image generation isn't configured for this store yet.";
const INVALID_OUTPUT_MESSAGE = "The AI provider returned an unexpected result. Please try again.";

function formatFromContentType(contentType: string): string | null {
  const match = /^image\/(\w+)/.exec(contentType);
  return match?.[1] ?? null;
}

async function persistOutput(
  shop: string,
  generationJobId: string,
  index: number,
  output: GeneratedImageOutput,
  providerName: string,
  identityValidation: IdentityValidationResult,
): Promise<CreateResultInput> {
  const format = formatFromContentType(output.contentType) ?? "bin";
  const key = `shops/${shop}/generations/${generationJobId}/${index}.${format}`;

  const storage = getConfiguredStorageProvider();
  const uploaded = await storage.upload({ key, body: output.data, contentType: output.contentType });
  const url = await storage.getSignedUrl({ key: uploaded.key, expiresInSeconds: 3600, operation: "get" });

  return {
    storageKey: uploaded.key,
    url,
    width: output.width ?? null,
    height: output.height ?? null,
    format: formatFromContentType(output.contentType),
    providerName,
    providerResultId: output.providerResultId ?? null,
    // See identity-validation.server.ts — an honest, structured "not yet
    // possible" result, not a fake pass, merged alongside whatever the
    // provider itself returned as output-level metadata.
    metadata: { ...(output.metadata ?? {}), identityValidation },
  };
}

export const processGenerationJob: Processor<GenerationJobPayload> = async (job) => {
  const { shop, generationJobId } = job.data;
  // BullMQ's own `attemptsMade` is 0 during the first run — see
  // services/ai/types.ts's `GenerateImageInput.attempt` doc comment.
  const attempt = job.attemptsMade + 1;
  const totalAttempts = job.opts.attempts ?? 1;

  logger.info("generation.job.start", { shop, generationJobId, attempt, totalAttempts });

  await markProcessing(shop, generationJobId, attempt);

  const context: AuthContext = { shop, sessionId: "worker:generation", isOnline: false };
  const attemptStartedAt = Date.now();

  try {
    const jobRow = await getGenerationJob(context, generationJobId);
    if (!jobRow) {
      // Row is gone (e.g. the product was deleted, cascading it away)
      // between enqueue and processing — nothing to do.
      logger.warn("generation.job.missing_row", { shop, generationJobId });
      return;
    }

    const plan = parseGenerationPlan(jobRow.plan);
    const input = buildGenerateImageInput(plan, attempt);
    const provider = getConfiguredImageGenerationProvider();
    const result = await provider.generateImage(input);
    assertValidGenerateImageResult(result);

    const identityValidation = plan.productFacts.identityAnchors
      ? recordIdentityValidation(plan.productFacts.identityAnchors)
      : { validated: false, reason: "no identity anchors present on this generation plan", identityAnchorsChecked: [] };
    const storedResults = await Promise.all(
      result.outputs.map((output, index) =>
        persistOutput(shop, generationJobId, index, output, provider.name, identityValidation),
      ),
    );
    await createResults(shop, generationJobId, storedResults);

    const durationMs = Date.now() - attemptStartedAt;
    await markSucceeded(shop, generationJobId, {
      providerName: provider.name,
      providerJobId: result.providerJobId,
      durationMs,
    });

    logger.info("generation.job.completed", {
      shop,
      generationJobId,
      providerName: provider.name,
      outputCount: storedResults.length,
      durationMs,
    });
  } catch (error) {
    const durationMs = Date.now() - attemptStartedAt;
    const isFinalAttempt = attempt >= totalAttempts;

    logger.error("generation.job.attempt_failed", {
      shop,
      generationJobId,
      attempt,
      totalAttempts,
      isFinalAttempt,
      detail: error instanceof Error ? error.message : "unknown error",
    });

    if (isFinalAttempt) {
      const message =
        error instanceof UnconfiguredAIProviderError
          ? NOT_CONFIGURED_MESSAGE
          : error instanceof InvalidGenerationResultError
            ? INVALID_OUTPUT_MESSAGE
            : GENERIC_FAILURE_MESSAGE;
      await markFailed(shop, generationJobId, { message, durationMs });
    }

    // Rethrow regardless — this is what tells BullMQ the attempt failed,
    // so it schedules the next retry (or gives up, if this was final).
    throw error;
  }
};
