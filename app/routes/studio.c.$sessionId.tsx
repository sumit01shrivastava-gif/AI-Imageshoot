/**
 * The standalone studio's conversation view — the non-Shopify
 * counterpart to app/routes/app.creative.$sessionId.tsx, built on the
 * exact same `services/creative-studio/session.server.ts` entry points
 * (`getCreativeSessionDetail`, `sendCreativeMessage`, `selectCreativeResult`,
 * `reviewCreativeResult`) — no second generation engine, no Shopify
 * Polaris web components (this route isn't embedded), no publish control
 * (a standalone session has no Shopify product to publish to — see
 * CreativeSessionRow.product's schema comment).
 */
import { useEffect, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import { TenantMismatchError } from "../../lib/auth";
import { withResultsSanitizedForClient } from "../../lib/storage";
import { logger } from "../../lib/logging/logger.server";
import {
  getCreativeSessionDetail,
  sendCreativeMessage,
  selectCreativeResult,
  reviewCreativeResult,
  recordCreativeFeedback,
  CreativeSessionNotFoundError,
  EmptyMessageError,
  ProductNotAnalyzedError,
  MissingSourceImagesError,
  InsufficientCreditsError,
  PlanLimitExceededError,
  GenerationResultNotFoundError,
} from "../../services/creative-studio/session.server";
import { getPlan } from "../../services/usage/entitlement.server";
import { Composer, type ComposerHandle } from "../components/composer";
import { StudioGenerationLoading } from "../components/studio-generation-loading";

const NOT_FOUND_RESPONSE = () => new Response("Conversation not found", { status: 404 });
const GENERIC_ERROR = "I couldn't complete that action. Please try again.";

const SUGGESTION_CHIPS = [
  "Make the background darker",
  "Make it feel more cinematic",
  "Change this to 4:5",
  "Give me another variation",
  "Use more premium lighting",
];

function jobStatusPhrase(status: string, outputCount: number): string {
  if (status === "PENDING" || status === "QUEUED") return "Preparing the visual direction…";
  if (status === "PROCESSING") return outputCount > 1 ? `Refining ${outputCount} variations…` : "Refining composition and light…";
  if (status === "SUCCEEDED") return "Your campaign image is ready.";
  if (status === "FAILED") return "That request didn't work out.";
  return "";
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { context } = await requireWorkspaceContext(request);

  let detail: Awaited<ReturnType<typeof getCreativeSessionDetail>>;
  try {
    detail = await getCreativeSessionDetail(context, params.sessionId!);
  } catch (error) {
    if (error instanceof CreativeSessionNotFoundError || error instanceof TenantMismatchError) {
      throw NOT_FOUND_RESPONSE();
    }
    throw error;
  }

  const plan = await getPlan(context.shop);

  return {
    session: detail.session,
    messages: detail.messages,
    // Generation plans contain internal Creative Director/provider
    // prompts and must never be serialized into the browser loader data.
    // The Studio needs only lifecycle metadata and sanitized results.
    jobs: detail.jobs.map((job) => {
      const sanitized = withResultsSanitizedForClient(job);
      return {
        id: sanitized.id,
        type: sanitized.type,
        status: sanitized.status,
        errorMessage: sanitized.errorMessage,
        retryCount: sanitized.retryCount,
        providerName: sanitized.providerName,
        startedAt: sanitized.startedAt,
        completedAt: sanitized.completedAt,
        durationMs: sanitized.durationMs,
        batchId: sanitized.batchId,
        creativeSessionId: sanitized.creativeSessionId,
        createdAt: sanitized.createdAt,
        updatedAt: sanitized.updatedAt,
        results: sanitized.results,
        product: sanitized.product,
      };
    }),
    entitlement: detail.entitlement,
    planName: plan.name,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { context, userId, workspaceId } = await requireWorkspaceContext(request);
  const sessionId = params.sessionId!;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "send-message") {
    const requestId = randomUUID();
    const message = formData.get("message");
    const files = formData.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
    if (typeof message !== "string") {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      const referenceImages = await Promise.all(
        files.map(async (file) => ({ data: new Uint8Array(await file.arrayBuffer()), contentType: file.type })),
      );
      const result = await sendCreativeMessage(context, sessionId, message, { referenceImages, userId });
      return { ok: true as const, generationJobId: result.generationJobId };
    } catch (error) {
      if (error instanceof CreativeSessionNotFoundError || error instanceof TenantMismatchError) {
        throw NOT_FOUND_RESPONSE();
      }
      if (error instanceof EmptyMessageError || error instanceof ProductNotAnalyzedError || error instanceof MissingSourceImagesError) {
        return { ok: false as const, error: error.message };
      }
      if (error instanceof InsufficientCreditsError || error instanceof PlanLimitExceededError) {
        return { ok: false as const, error: error.message, reason: "insufficient_credits" as const };
      }
      // Full, structured detail server-side (never the raw message text
      // or attachment bytes); the client only ever sees GENERIC_ERROR.
      logger.error("studio.send_message_failed", {
        requestId,
        workspaceId,
        userId,
        sessionId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        detail: error instanceof Error ? error.message : "unknown error",
      });
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  if (intent === "select-result") {
    const resultId = formData.get("resultId");
    if (typeof resultId !== "string") {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      await selectCreativeResult(context, sessionId, resultId);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof CreativeSessionNotFoundError || error instanceof TenantMismatchError) {
        throw NOT_FOUND_RESPONSE();
      }
      if (error instanceof GenerationResultNotFoundError) {
        return { ok: false as const, error: "That version couldn't be found." };
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  if (intent === "review") {
    const resultId = formData.get("resultId");
    const decision = formData.get("decision");
    if (typeof resultId !== "string" || (decision !== "APPROVED" && decision !== "REJECTED")) {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      await reviewCreativeResult(context, resultId, decision, userId);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof GenerationResultNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  // The explicit "I like this style"/"not my style" reaction — see
  // services/creative-studio/personalization.server.ts's module doc
  // comment. Distinct from Approve/Reject (which is about whether a
  // result is fit to use, not taste) and, unlike Approve/Reject, has no
  // persisted status to reflect back — it only ever feeds the learning
  // signal, so a bare `{ ok: true }` is genuinely the whole response.
  if (intent === "feedback") {
    const resultId = formData.get("resultId");
    const signal = formData.get("signal");
    if (typeof resultId !== "string" || (signal !== "positive" && signal !== "negative")) {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    await recordCreativeFeedback(context, userId, resultId, signal);
    return { ok: true as const };
  }

  return { ok: false as const, error: "Unknown action." };
};

export default function StudioConversation() {
  const { session, messages, jobs, entitlement, planName } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const messageFetcher = useFetcher<typeof action>();
  const selectFetcher = useFetcher<typeof action>();
  const reviewFetcher = useFetcher<typeof action>();
  const feedbackFetcher = useFetcher<typeof action>();
  const composerRef = useRef<ComposerHandle>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  const latestJob = jobs[0] ?? null;
  const isInFlight = latestJob ? ["PENDING", "QUEUED", "PROCESSING"].includes(latestJob.status) : false;

  useEffect(() => {
    if (!isInFlight) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [isInFlight, revalidator]);

  // Derived directly from each fetcher's own last response — no local
  // state/effect needed (and no risk of the cascading-render pattern
  // `setState`-in-an-effect creates): the most recent action failure
  // across the three fetchers, in submission-recency order, is exactly
  // what should be visible until the next successful action replaces it.
  const latestActionError =
    (selectFetcher.data && !selectFetcher.data.ok && selectFetcher.data.error) ||
    (reviewFetcher.data && !reviewFetcher.data.ok && reviewFetcher.data.error) ||
    (messageFetcher.data && !messageFetcher.data.ok && messageFetcher.data.error) ||
    null;

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const isSending = messageFetcher.state !== "idle";
  const optimisticMessage = isSending ? pendingMessage : null;
  const isGenerating = isInFlight || Boolean(optimisticMessage);
  const insufficientCredits =
    messageFetcher.data && !messageFetcher.data.ok && "reason" in messageFetcher.data && messageFetcher.data.reason === "insufficient_credits";

  const currentResult = latestJob?.results.find((r) => r.id === session.currentResultId) ?? latestJob?.results[latestJob.results.length - 1] ?? null;

function submitMessage(text: string, files: File[] = []) {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && files.length === 0) || isSending) return;
    const formData = new FormData();
    formData.set("intent", "send-message");
    formData.set("message", trimmed);
    files.forEach((file) => formData.append("images", file));
    setPendingMessage(trimmed || "Create a clean, professional product photo from this image.");
    messageFetcher.submit(formData, { method: "POST", encType: "multipart/form-data" });
  }

  function focusComposer() {
    document.querySelector<HTMLTextAreaElement>(".studio-chat-composer textarea")?.focus();
  }

  return (
    <div className="studio-conv">
      <section className="studio-canvas">
        {latestJob?.status === "FAILED" && (
          <div className="studio-banner" data-tone="critical">
            <span>{latestJob.errorMessage ?? "Generation failed."}</span>
          </div>
        )}

        {!currentResult ? (
          <div className="studio-canvas-stage">
            {isGenerating ? (
              <StudioGenerationLoading
                title={latestJob ? jobStatusPhrase(latestJob.status, latestJob.results.length || 1) : "Your creative request is underway…"}
                activeStep={latestJob?.status === "PROCESSING" ? 2 : 0}
              />
            ) : (
              <p className="studio-canvas-placeholder">Nothing generated yet — describe what you want below to get started.</p>
            )}
          </div>
        ) : (
          <div className="studio-canvas-stage">{currentResult.url && <img src={currentResult.url} alt="Current result" />}</div>
        )}

        {isInFlight && currentResult && (
          <p className="studio-meta-row">{jobStatusPhrase(latestJob!.status, latestJob!.results.length || 1)}</p>
        )}

        {latestJob && latestJob.results.length > 1 && (
          <div className="studio-versions">
            {latestJob.results.map((result, index) => (
              <button
                key={result.id}
                type="button"
                className="studio-version-thumb"
                data-selected={result.id === currentResult?.id}
                aria-label={`Show version ${index + 1}${result.id === currentResult?.id ? " (currently shown)" : ""}`}
                onClick={() => selectFetcher.submit({ intent: "select-result", resultId: result.id }, { method: "POST" })}
              >
                {result.url && <img src={result.url} alt="" />}
              </button>
            ))}
          </div>
        )}

        {currentResult && (
          <div className="studio-canvas-actions">
            <span className="studio-meta-row">
              {currentResult.width && currentResult.height ? `${currentResult.width}×${currentResult.height}` : "—"}
              <span
                className="studio-badge"
                data-tone={currentResult.reviewStatus === "APPROVED" ? "success" : currentResult.reviewStatus === "REJECTED" ? "error" : undefined}
              >
                {currentResult.reviewStatus === "APPROVED" ? "Approved" : currentResult.reviewStatus === "REJECTED" ? "Rejected" : "Not reviewed"}
              </span>
            </span>
            {currentResult.url && (
              <a className="studio-btn" data-variant="primary" href={currentResult.url} target="_blank" rel="noreferrer" download="creation.png">
                Download
              </a>
            )}
            <button type="button" className="studio-btn" onClick={focusComposer} disabled={isSending}>Edit / Continue</button>
            <details className="studio-more-actions">
              <summary>More actions</summary>
              <div className="studio-secondary-actions">
                <button type="button" className="studio-btn" onClick={() => submitMessage("Give me another variation.")} disabled={isSending}>Variation</button>
                <button type="button" className="studio-btn" onClick={() => submitMessage("Regenerate this.")} disabled={isSending}>Regenerate</button>
                <button type="button" className="studio-btn" disabled={currentResult.reviewStatus === "APPROVED"} onClick={() => reviewFetcher.submit({ intent: "review", resultId: currentResult.id, decision: "APPROVED" }, { method: "POST" })}>Approve</button>
                <button type="button" className="studio-btn" data-variant="danger" disabled={currentResult.reviewStatus === "REJECTED"} onClick={() => reviewFetcher.submit({ intent: "review", resultId: currentResult.id, decision: "REJECTED" }, { method: "POST" })}>Reject</button>
                <button type="button" className="studio-btn" onClick={() => feedbackFetcher.submit({ intent: "feedback", resultId: currentResult.id, signal: "positive" }, { method: "POST" })}>Love this style</button>
                <button type="button" className="studio-btn" onClick={() => feedbackFetcher.submit({ intent: "feedback", resultId: currentResult.id, signal: "negative" }, { method: "POST" })}>Not my style</button>
              </div>
            </details>
          </div>
        )}
      </section>

      <section className="studio-chat">
        <div className="studio-chat-header">
          <span
            className="studio-credit-pill"
            data-low={entitlement.available > 0 && entitlement.available <= entitlement.limit * 0.15}
            data-empty={entitlement.available <= 0}
          >
            {entitlement.available} credits remaining · {planName} plan
          </span>
        </div>

        <div className="studio-transcript">
          {messages.length === 0 && (
            <p className="studio-canvas-placeholder" style={{ padding: 0 }}>
              Every request keeps your reference image (if any) intact unless you ask otherwise.
            </p>
          )}
          {messages.map((message) => (
            <div key={message.id} className="studio-msg" data-role={message.role === "SYSTEM" ? "ASSISTANT" : message.role}>
              {message.content}
            </div>
          ))}
          {optimisticMessage && <div className="studio-msg studio-msg-pending" data-role="USER">{optimisticMessage}</div>}
          {optimisticMessage && (
            <div className="studio-msg studio-msg-pending" data-role="ASSISTANT">
              I&rsquo;ve got it — your creative direction is now in motion.
            </div>
          )}
          {/* Must NOT disappear the moment a job finishes — SUCCEEDED
              gets its own confirmation line here too, not just while
              in flight (FAILED already has its own, more specific
              banner above). */}
          {(latestJob && latestJob.status !== "FAILED") && (
            <div className="studio-status-line" role="status" aria-live="polite">
              {isInFlight && <span className="studio-dot-pulse" aria-hidden="true" />}
              {jobStatusPhrase(latestJob.status, latestJob.results.length || 1)}
            </div>
          )}
          <div ref={transcriptEndRef} />
        </div>

        {insufficientCredits && (
          <div className="studio-banner" data-tone="warning">
            <span>{messageFetcher.data && !messageFetcher.data.ok ? messageFetcher.data.error : ""}</span>
          </div>
        )}
        {latestActionError && !insufficientCredits && (
          <div className="studio-banner" data-tone="critical">
            <span>{latestActionError}</span>
          </div>
        )}

        <div className="studio-chat-composer">
          {messages.length > 0 && (
            <div className="studio-example-row" style={{ marginBottom: "10px", justifyContent: "flex-start" }}>
              {SUGGESTION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="studio-example-chip"
                  disabled={isSending}
                  onClick={() => submitMessage(chip)}
                >
                  {chip}
                </button>
              ))}
            </div>
          )}
          <Composer ref={composerRef} disabled={isSending} busy={isSending} onSubmit={submitMessage} placeholder="Make the background darker…" />
        </div>
      </section>
    </div>
  );
}
