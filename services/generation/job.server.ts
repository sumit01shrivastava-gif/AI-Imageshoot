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
import { recordUsageEvent } from "../usage/usage-accounting.server";
import { settleGenerationCredits, refundGenerationCredits } from "../usage/entitlement.server";
import { setCurrentResult } from "../../db/repositories/creative-session.repository";

/** Records one usage-ledger event for this job's terminal outcome — see
 * services/usage/usage-accounting.server.ts's module doc comment for why
 * this happens alongside markSucceeded/markFailed. Never allowed to fail
 * the job itself: a usage-ledger write failure is logged and swallowed,
 * not rethrown — the merchant's actual generation result must never be
 * held hostage to accounting bookkeeping. */
async function recordGenerationUsage(
  shop: string,
  generationJobId: string,
  status: "SUCCEEDED" | "FAILED",
  detail: { providerName?: string; outputCount?: number; durationMs?: number },
): Promise<void> {
  try {
    await recordUsageEvent({
      shop,
      operationType: "IMAGE_GENERATION",
      status,
      jobId: generationJobId,
      providerName: detail.providerName ?? null,
      outputCount: detail.outputCount ?? 0,
      durationMs: detail.durationMs ?? null,
    });
  } catch (error) {
    logger.warn("generation.job.usage_record_failed", {
      shop,
      generationJobId,
      detail: error instanceof Error ? error.message : "unknown error",
    });
  }
}

/** Settles or refunds this job's credit reservation, if it has one — see
 * services/usage/entitlement.server.ts. Every generationType now reserves
 * credits before enqueueing (request-generation.server.ts) EXCEPT that a
 * Creative Studio job's reservation is made by
 * services/creative-studio/session.server.ts itself, before this job even
 * exists — either way, exactly one reservation exists per job by the
 * time it runs, so this call always has something real to resolve.
 * settle/refund are themselves conditional updates that affect zero rows
 * when no reservation exists at all (e.g. a job created directly by a
 * test without going through the request-side entry points) — a harmless
 * no-op, not an error. Never allowed to fail the job itself, same
 * reasoning as `recordGenerationUsage`. */
async function resolveGenerationCredits(
  shop: string,
  generationJobId: string,
  outcome: "SUCCEEDED" | "FAILED",
): Promise<void> {
  const context: AuthContext = { shop, sessionId: "worker:generation", isOnline: false };
  try {
    if (outcome === "SUCCEEDED") {
      await settleGenerationCredits(context, generationJobId);
    } else {
      await refundGenerationCredits(context, generationJobId);
    }
  } catch (error) {
    logger.warn("generation.job.credit_resolution_failed", {
      shop,
      generationJobId,
      outcome,
      detail: error instanceof Error ? error.message : "unknown error",
    });
  }
}

/** For a Creative Studio-originated job that just SUCCEEDED, makes its
 * first result the session's new "current working image" — without
 * this, a session's canvas would stay empty until the merchant manually
 * picked a variation (see docs/creative-studio.md "Session lifecycle").
 * `resultIds` is oldest-first (the same order `persistOutput`/`createResults`
 * wrote them in), so `[0]` is the primary result for a single-image
 * request and a stable, deterministic default for a multi-variation one
 * (the merchant can still switch via the version thumbnails). Never
 * allowed to fail the job itself, same reasoning as
 * `resolveGenerationCredits`. */
async function setInitialCreativeSessionResult(
  shop: string,
  generationJobId: string,
  creativeSessionId: string | null,
  resultIds: string[],
): Promise<void> {
  if (!creativeSessionId || resultIds.length === 0) return;
  try {
    await setCurrentResult(shop, creativeSessionId, resultIds[0]);
  } catch (error) {
    logger.warn("generation.job.creative_session_result_link_failed", {
      shop,
      generationJobId,
      creativeSessionId,
      detail: error instanceof Error ? error.message : "unknown error",
    });
  }
}

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

  const context: AuthContext = { shop, sessionId: "worker:generation", isOnline: false };

  // Idempotency guard — checked BEFORE `markProcessing` (which
  // unconditionally overwrites `status`, so checking after it would
  // never see "SUCCEEDED"). A job only ever reaches SUCCEEDED once, at
  // the bottom of the try block below, right before returning — the
  // ONLY way this processor runs again for an already-SUCCEEDED job is a
  // redelivered/duplicate BullMQ job, or a prior attempt that created
  // results and then failed on the write to `markSucceeded` itself
  // (rare, but possible on a transient DB error). Either way, results
  // already exist — creating them again would double them, and even
  // re-marking status/timestamps on an already-terminal job is pointless
  // work — so this bails out before touching anything. See
  // docs/generation-pipeline.md "Idempotency".
  const existingJobRow = await getGenerationJob(context, generationJobId);
  if (existingJobRow?.status === "SUCCEEDED") {
    logger.info("generation.job.already_succeeded", { shop, generationJobId, attempt });
    return;
  }

  await markProcessing(shop, generationJobId, attempt);

  const attemptStartedAt = Date.now();
  // Read once `jobRow` is fetched inside the `try` below, then reused in
  // the `catch` block too (a plain outer-scoped variable, since `jobRow`
  // itself is block-scoped to `try`) — see `resolveGenerationCredits`'s
  // doc comment for why every generationType calls it unconditionally
  // and only a Creative Studio job actually has anything to resolve.
  let creativeSessionId: string | null = null;

  try {
    const jobRow = await getGenerationJob(context, generationJobId);
    if (!jobRow) {
      // Row is gone (e.g. the product was deleted, cascading it away)
      // between enqueue and processing — nothing to do.
      logger.warn("generation.job.missing_row", { shop, generationJobId });
      return;
    }
    creativeSessionId = jobRow.creativeSessionId;

    const plan = parseGenerationPlan(jobRow.plan);
    const input = buildGenerateImageInput(plan, attempt);
    const provider = getConfiguredImageGenerationProvider();
    const result = await provider.generateImage(input);
    assertValidGenerateImageResult(result);

    const identityValidation = plan.productFacts.identityAnchors
      ? recordIdentityValidation(plan.productFacts.identityAnchors)
      : { validated: false, reason: "no identity anchors present on this generation plan", identityAnchorsChecked: [] };
    // `allSettled`, not `all` — with more than one output, `all` would
    // reject as soon as ONE upload fails while the OTHERS may have
    // already succeeded and be sitting in storage; their storage keys
    // would never reach us (a rejected Promise.all discards every
    // settled value), so they'd be orphaned forever. Settling every
    // upload first lets us see exactly which ones actually landed, so a
    // partial failure can still clean up after itself (see docs/storage.md
    // "Orphaned object prevention" — "partial multi-output failure").
    const uploadOutcomes = await Promise.allSettled(
      result.outputs.map((output, index) =>
        persistOutput(shop, generationJobId, index, output, provider.name, identityValidation),
      ),
    );
    const uploadFailure = uploadOutcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
    if (uploadFailure) {
      const succeeded = uploadOutcomes.filter(
        (o): o is PromiseFulfilledResult<CreateResultInput> => o.status === "fulfilled",
      );
      const failedCount = uploadOutcomes.length - succeeded.length;
      // A GenerationJob's outcome is all-or-nothing (SUCCEEDED or FAILED
      // — there is no "3 of 4 outputs" partial-success state in the data
      // model, matching every review/regenerate flow built against it),
      // so ANY output failing here fails the whole attempt. That's a
      // deliberate, existing design choice, not something this event
      // changes — it exists purely so the partial upload outcome (how
      // many succeeded before the failure, and how many of those are
      // about to be cleaned back out of storage) is explicit and
      // observable rather than silently folded into the generic
      // `attempt_failed` log below.
      logger.warn("generation.job.partial_upload_failure", {
        shop,
        generationJobId,
        attemptedOutputs: uploadOutcomes.length,
        succeededOutputs: succeeded.length,
        failedOutputs: failedCount,
      });
      await Promise.all(
        succeeded.map((o) =>
          getConfiguredStorageProvider()
            .delete(o.value.storageKey)
            .catch((cleanupError: unknown) =>
              logger.warn("generation.job.orphan_cleanup_failed", {
                shop,
                generationJobId,
                storageKey: o.value.storageKey,
                detail: cleanupError instanceof Error ? cleanupError.message : "unknown error",
              }),
            ),
        ),
      );
      throw uploadFailure.reason;
    }
    const storedResults = uploadOutcomes.map((o) => (o as PromiseFulfilledResult<CreateResultInput>).value);

    try {
      await createResults(shop, generationJobId, storedResults);
    } catch (persistError) {
      // The provider call and every upload succeeded, but the DB write
      // that would make them visible/referenced didn't — clean up the
      // now-orphaned storage objects rather than leaving them
      // unreferenced forever (see docs/storage.md "Orphaned object
      // prevention"). Best-effort: a cleanup failure is logged, never
      // allowed to mask the real, original error.
      await Promise.all(
        storedResults.map((stored) =>
          getConfiguredStorageProvider()
            .delete(stored.storageKey)
            .catch((cleanupError: unknown) =>
              logger.warn("generation.job.orphan_cleanup_failed", {
                shop,
                generationJobId,
                storageKey: stored.storageKey,
                detail: cleanupError instanceof Error ? cleanupError.message : "unknown error",
              }),
            ),
        ),
      );
      throw persistError;
    }

    const durationMs = Date.now() - attemptStartedAt;
    // Usage/credit bookkeeping runs BEFORE `markSucceeded` writes the
    // terminal status — deliberately, not after: `markSucceeded` is what
    // makes this job's outcome externally OBSERVABLE (a route/test
    // polling job status, or a merchant's page reflecting a completed
    // generation), so anything that outcome is supposed to imply (the
    // usage ledger, the credit reservation settling to CONSUMED) must
    // already be durable by the time that becomes visible — otherwise a
    // caller can observe "SUCCEEDED" while the credit is still RESERVED,
    // a real, empirically-reproduced race under load (see
    // tests/integration/creative-studio/session.test.ts's mirrored
    // FAILED-path regression test). Same "make the observable state
    // change last" reasoning `createAndEnqueueGenerationJob`'s
    // `markQueued`-before-`enqueue` ordering already uses, applied to the
    // opposite end of a job's lifecycle.
    await recordGenerationUsage(shop, generationJobId, "SUCCEEDED", {
      providerName: provider.name,
      outputCount: storedResults.length,
      durationMs,
    });
    await resolveGenerationCredits(shop, generationJobId, "SUCCEEDED");
    await markSucceeded(shop, generationJobId, {
      providerName: provider.name,
      providerJobId: result.providerJobId,
      durationMs,
    });
    if (creativeSessionId) {
      // A fresh read (rather than threading ids through `storedResults`,
      // which are pre-insert shapes with no DB-assigned id yet) — cheap,
      // and only ever happens for a Creative Studio job.
      const freshJobRow = await getGenerationJob(context, generationJobId);
      await setInitialCreativeSessionResult(
        shop,
        generationJobId,
        creativeSessionId,
        freshJobRow?.results.map((r) => r.id) ?? [],
      );
    }

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
      // Only recorded once the job has truly, terminally failed (final
      // attempt) — an intermediate retry failure is not yet a billable
      // "failed operation", it's a step the queue's own retry may still
      // recover from.
      await recordGenerationUsage(shop, generationJobId, "FAILED", { durationMs });
      // Same reasoning — a reserved credit is only refunded once the job
      // has truly, terminally failed, never on an intermediate retry
      // attempt the queue may still recover from (see Part 11: "Failed
      // generation must not consume permanent credits"). Run BEFORE
      // `markFailed` for the same "make the observable state change
      // last" reasoning as the SUCCEEDED path above — a caller polling
      // for FAILED must never see it before the reservation has actually
      // been refunded.
      await resolveGenerationCredits(shop, generationJobId, "FAILED");
      await markFailed(shop, generationJobId, { message, durationMs });
    }

    // Rethrow regardless — this is what tells BullMQ the attempt failed,
    // so it schedules the next retry (or gives up, if this was final).
    throw error;
  }
};
