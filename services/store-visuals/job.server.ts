/**
 * BullMQ job payload + processor for the `"store-visuals"` queue — mirrors
 * services/generation/job.server.ts closely (job-id/retry semantics
 * identical: `(shop, storeVisualJobId)`-keyed, `attempts: 3` automatic
 * retry — see that file's module doc comment for the full reasoning,
 * which applies unchanged here). Reuses the SAME `ImageGenerationProvider`
 * resolver, `StorageProvider`, and identity-validation boundary function
 * as services/generation/ — a store visual is a different shape of
 * request, not a different provider/storage/validation pipeline.
 */
import type { Processor } from "bullmq";
import { buildJobId } from "../../lib/queue/job-id";
import { logger } from "../../lib/logging/logger.server";
import { getConfiguredStorageProvider } from "../../lib/storage";
import type { AuthContext } from "../../lib/auth/types";
import {
  getStoreVisualJob,
  markProcessing,
  markSucceeded,
  markFailed,
  createResults,
  type CreateResultInput,
} from "../../db/repositories/store-visual-job.repository";
import { buildGenerateImageInput } from "./build-input";
import { getConfiguredImageGenerationProvider } from "../generation/provider.server";
import { parseStoreVisualPlan, assertValidGenerateImageResult, InvalidGenerationResultError } from "./schema";
import { recordIdentityValidation } from "../generation/identity-validation.server";
import { UnconfiguredAIProviderError } from "../ai/unconfigured-provider";
import type { GeneratedImageOutput } from "../ai/types";
import type { StoreVisualPlan } from "./schema";

export interface StoreVisualJobPayload {
  shop: string;
  storeVisualJobId: string;
}

export function storeVisualBullJobId(payload: StoreVisualJobPayload): string {
  return buildJobId("store-visual", payload.shop, payload.storeVisualJobId);
}

const GENERIC_FAILURE_MESSAGE = "Generation failed. Please try again in a moment.";
const NOT_CONFIGURED_MESSAGE = "Image generation isn't configured for this store yet.";
const INVALID_OUTPUT_MESSAGE = "The AI provider returned an unexpected result. Please try again.";

function formatFromContentType(contentType: string): string | null {
  const match = /^image\/(\w+)/.exec(contentType);
  return match?.[1] ?? null;
}

/** One identity-validation result per referenced product that has
 * identity anchors — a store visual can feature several products, unlike
 * services/generation/'s single-product boundary. An honest, empty
 * result for a fully generic visual (no products, or none with anchors
 * available) — never fabricated. */
function recordStoreVisualIdentityValidation(plan: StoreVisualPlan) {
  const withAnchors = plan.products.filter((ref) => ref.identityAnchors !== null);
  if (withAnchors.length === 0) {
    return {
      validated: false,
      reason:
        plan.products.length === 0
          ? "no products referenced by this store visual"
          : "no vision-capable provider configured, and no referenced product has identity anchors available",
      products: [] as Array<{ productId: string; identityAnchorsChecked: string[] }>,
    };
  }
  return {
    validated: false,
    reason: "no vision-capable provider configured",
    products: withAnchors.map((ref) => ({
      productId: ref.productId,
      identityAnchorsChecked: recordIdentityValidation(ref.identityAnchors!).identityAnchorsChecked,
    })),
  };
}

async function persistOutput(
  shop: string,
  storeVisualJobId: string,
  index: number,
  output: GeneratedImageOutput,
  providerName: string,
  identityValidation: ReturnType<typeof recordStoreVisualIdentityValidation>,
): Promise<CreateResultInput> {
  const format = formatFromContentType(output.contentType) ?? "bin";
  const key = `shops/${shop}/store-visuals/${storeVisualJobId}/${index}.${format}`;

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
    metadata: { ...(output.metadata ?? {}), identityValidation },
  };
}

export const processStoreVisualJob: Processor<StoreVisualJobPayload> = async (job) => {
  const { shop, storeVisualJobId } = job.data;
  const attempt = job.attemptsMade + 1;
  const totalAttempts = job.opts.attempts ?? 1;

  logger.info("store_visual.job.start", { shop, storeVisualJobId, attempt, totalAttempts });

  await markProcessing(shop, storeVisualJobId, attempt);

  const context: AuthContext = { shop, sessionId: "worker:store-visuals", isOnline: false };
  const attemptStartedAt = Date.now();

  try {
    const jobRow = await getStoreVisualJob(context, storeVisualJobId);
    if (!jobRow) {
      // Row is gone (e.g. every referenced product was deleted between
      // enqueue and processing, cascading the job's product refs away —
      // but NOT the job row itself, since StoreVisualJobProduct cascades
      // away from StoreVisualJob, not the reverse) — nothing to do.
      logger.warn("store_visual.job.missing_row", { shop, storeVisualJobId });
      return;
    }

    const plan = parseStoreVisualPlan(jobRow.plan);
    const input = buildGenerateImageInput(plan, attempt);
    const provider = getConfiguredImageGenerationProvider();
    const result = await provider.generateImage(input);
    assertValidGenerateImageResult(result);

    const identityValidation = recordStoreVisualIdentityValidation(plan);
    const storedResults = await Promise.all(
      result.outputs.map((output, index) =>
        persistOutput(shop, storeVisualJobId, index, output, provider.name, identityValidation),
      ),
    );
    await createResults(shop, storeVisualJobId, storedResults);

    const durationMs = Date.now() - attemptStartedAt;
    await markSucceeded(shop, storeVisualJobId, {
      providerName: provider.name,
      providerJobId: result.providerJobId,
      durationMs,
    });

    logger.info("store_visual.job.completed", {
      shop,
      storeVisualJobId,
      providerName: provider.name,
      outputCount: storedResults.length,
      durationMs,
    });
  } catch (error) {
    const durationMs = Date.now() - attemptStartedAt;
    const isFinalAttempt = attempt >= totalAttempts;

    logger.error("store_visual.job.attempt_failed", {
      shop,
      storeVisualJobId,
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
      await markFailed(shop, storeVisualJobId, { message, durationMs });
    }

    throw error;
  }
};
