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
import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import { useFetcher, useLoaderData, useRevalidator, type ActionFunctionArgs, type HeadersFunction, type LoaderFunctionArgs, type ShouldRevalidateFunction } from "react-router";
import { requireWorkspaceContext } from "../../lib/auth/standalone-session.server";
import { TenantMismatchError } from "../../lib/auth";
import { withResultsSanitizedForClient } from "../../lib/storage";
import { logger } from "../../lib/logging/logger.server";
import {
  getCreativeSessionDetail,
  getCreativeSessionGenerationStatus,
  type CreativeSessionDetail,
  canRecordCreativeStudioTelemetry,
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
import { Composer, type ComposerAttachment } from "../components/composer";
import { StudioGenerationLoading } from "../components/studio-generation-loading";
import { StudioResultImage } from "../components/studio-result-image";
import { isStudioLatencyEvent, type StudioLatencyEvent } from "../components/studio-ttfvi";
import { isPendingStudioTurnReconciled, releaseOptimisticAttachments, type PendingStudioTurn } from "../components/studio-optimistic-turn";
import { mergeStudioJobSnapshots } from "../components/studio-job-snapshot";
import { generationProgressStage, hasActiveGeneration, isGenerationActiveStage, isResultRenderable, type GenerationProgressStage } from "../../services/generation/progress";

const NOT_FOUND_RESPONSE = () => new Response("Conversation not found", { status: 404 });
const GENERIC_ERROR = "I couldn't complete that action. Please try again.";

const SUGGESTION_CHIPS = ["Change the scene", "Try a variation", "Change the format"];

function jobStatusPhrase(stage: GenerationProgressStage, outputCount: number): string {
  if (stage === "PREPARING") return "Reading your direction…";
  if (stage === "PLANNING" || stage === "QUEUED") return "Setting the creative direction…";
  if (stage === "GENERATING") return outputCount > 1 ? `Creating ${outputCount} variations…` : "Creating your image…";
  if (stage === "CHECKING_QUALITY") return "Checking the finished image…";
  if (stage === "COMPLETED") return "Your campaign image is ready.";
  if (stage === "FAILED") return "That request didn't work out.";
  return "";
}

function attachmentsForMessage(value: unknown): Array<{ url: string; contentType: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    return typeof value.url === "string" ? [{ url: value.url, contentType: typeof value.contentType === "string" ? value.contentType : "image/*" }] : [];
  });
}

function renderMessageContent(content: string) {
  return content.split(/\n/).map((line, index) => <span key={`${index}-${line}`}>{line || "\u00a0"}<br /></span>);
}

/** The dynamic conversation status is deliberately serialised once for both
 * the full loader and the lightweight active-generation poll. */
function serializeStudioJobs(jobs: CreativeSessionDetail["jobs"]) {
  return jobs.map((job) => {
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
      progressStage: generationProgressStage(sanitized.status, sanitized.results.length),
      product: sanitized.product,
    };
  });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const loaderStartedAt = Date.now();
  const { context } = await requireWorkspaceContext(request);

  let detail: Awaited<ReturnType<typeof getCreativeSessionDetail>>;
  const planPromise = getPlan(context.shop);
  try {
    detail = await getCreativeSessionDetail(context, params.sessionId!);
  } catch (error) {
    if (error instanceof CreativeSessionNotFoundError || error instanceof TenantMismatchError) {
      throw NOT_FOUND_RESPONSE();
    }
    throw error;
  }

  const plan = await planPromise;

  return {
    session: detail.session,
    messages: detail.messages,
    // Generation plans contain internal Creative Director/provider
    // prompts and must never be serialized into the browser loader data.
    // The Studio needs only lifecycle metadata and sanitized results.
    jobs: serializeStudioJobs(detail.jobs),
    entitlement: detail.entitlement,
    planName: plan.name,
    telemetry: { ...detail.telemetry, loaderDurationMs: Date.now() - loaderStartedAt },
  };
};

// Conversation state is account-specific and changes while a worker runs.
// Explicitly prevent browser/CDN reuse of an old loader payload.
export const headers: HeadersFunction = () => ({ "Cache-Control": "private, no-store" });

/** Status snapshots return directly to their fetcher; do not turn each
 * one-second poll into a full transcript/shell reload. */
export const shouldRevalidate: ShouldRevalidateFunction = ({ formData, defaultShouldRevalidate }) =>
  formData?.get("intent") === "poll-generation-status" ? false : defaultShouldRevalidate;

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { context, userId, workspaceId } = await requireWorkspaceContext(request);
  const sessionId = params.sessionId!;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "poll-generation-status") {
    try {
      const detail = await getCreativeSessionGenerationStatus(context, sessionId);
      return {
        ok: true as const,
        kind: "generation-status" as const,
        jobs: serializeStudioJobs(detail.jobs),
        telemetry: detail.telemetry,
      };
    } catch (error) {
      if (error instanceof CreativeSessionNotFoundError || error instanceof TenantMismatchError) throw NOT_FOUND_RESPONSE();
      logger.warn("studio.poll_generation_status_failed", {
        workspaceId, userId, sessionId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

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

  if (intent === "record-studio-latency") {
    const event = formData.get("event");
    const generationJobId = formData.get("generationJobId");
    const resultId = formData.get("resultId");
    const occurredAt = Number(formData.get("occurredAt"));
    const submittedAt = formData.has("submittedAt") ? Number(formData.get("submittedAt")) : null;
    const attachmentCount = formData.has("attachmentCount") ? Number(formData.get("attachmentCount")) : null;
    const resultCount = formData.has("resultCount") ? Number(formData.get("resultCount")) : null;
    const loaderDurationMs = formData.has("loaderDurationMs") ? Number(formData.get("loaderDurationMs")) : null;
    const resultSigningMs = formData.has("resultSigningMs") ? Number(formData.get("resultSigningMs")) : null;
    const resultSigningCount = formData.has("resultSigningCount") ? Number(formData.get("resultSigningCount")) : null;
    const resourceDurationMs = formData.has("resourceDurationMs") ? Number(formData.get("resourceDurationMs")) : null;
    const values = [occurredAt, submittedAt, attachmentCount, resultCount, loaderDurationMs, resultSigningMs, resultSigningCount, resourceDurationMs];
    if (
      typeof event !== "string" || !isStudioLatencyEvent(event) || !Number.isFinite(occurredAt) || occurredAt <= 0 ||
      values.some((value) => value !== null && (!Number.isFinite(value) || value < 0)) ||
      (generationJobId !== null && typeof generationJobId !== "string") ||
      (resultId !== null && typeof resultId !== "string")
    ) return { ok: false as const, error: GENERIC_ERROR };

    const belongsToSession = await canRecordCreativeStudioTelemetry(
      context,
      sessionId,
      typeof generationJobId === "string" ? generationJobId : null,
      typeof resultId === "string" ? resultId : null,
    );
    if (!belongsToSession) return { ok: false as const, error: GENERIC_ERROR };

    // Best-effort observability only: never a prompt, URL, filename or image.
    logger.info("studio.latency", {
      workspaceId, userId, sessionId, event, occurredAt,
      ...(typeof generationJobId === "string" ? { generationJobId } : {}),
      ...(typeof resultId === "string" ? { resultId } : {}),
      ...(submittedAt !== null ? { submittedAt, elapsedSinceSubmitMs: occurredAt - submittedAt } : {}),
      ...(attachmentCount !== null ? { attachmentCount } : {}),
      ...(resultCount !== null ? { resultCount } : {}),
      ...(loaderDurationMs !== null ? { loaderDurationMs } : {}),
      ...(resultSigningMs !== null ? { resultSigningMs } : {}),
      ...(resultSigningCount !== null ? { resultSigningCount } : {}),
      ...(resourceDurationMs !== null ? { resourceDurationMs } : {}),
    });
    return { ok: true as const };
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
  const { session, messages, jobs, entitlement, planName, telemetry } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const messageFetcher = useFetcher<typeof action>();
  const statusFetcher = useFetcher<typeof action>();
  const selectFetcher = useFetcher<typeof action>();
  const reviewFetcher = useFetcher<typeof action>();
  const feedbackFetcher = useFetcher<typeof action>();
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const shouldFollowTranscriptRef = useRef(true);
  const pendingTurnRef = useRef<PendingStudioTurn | null>(null);
  // Local to this mounted conversation: preserves a genuine client submit
  // timestamp after optimistic attachment URLs have been released.
  const submitTimesByJobRef = useRef(new Map<string, number>());
  const [pendingTurn, setPendingTurn] = useState<PendingStudioTurn | null>(null);
  const latencyEmittedRef = useRef(new Set<string>());

  const polledJobs = statusFetcher.data && statusFetcher.data.ok && "kind" in statusFetcher.data && statusFetcher.data.kind === "generation-status"
    ? statusFetcher.data.jobs
    : null;
  const observedJobs = polledJobs ? mergeStudioJobSnapshots(jobs, polledJobs) : jobs;
  const latestJob = observedJobs[0] ?? null;
  const isInFlight = hasActiveGeneration(observedJobs);
  const optimisticTurnReconciled = isPendingStudioTurnReconciled(pendingTurn, messages);

  const emitLatency = useCallback((
    event: StudioLatencyEvent,
    generationJobId?: string | null,
    resultId?: string | null,
    metadata: Record<string, number> = {},
    occurredAt = Date.now(),
  ) => {
    const key = `${event}:${generationJobId ?? "turn"}:${resultId ?? ""}`;
    if (latencyEmittedRef.current.has(key)) return;
    latencyEmittedRef.current.add(key);
    const body = new FormData();
    body.set("intent", "record-studio-latency");
    body.set("event", event);
    body.set("occurredAt", String(occurredAt));
    if (generationJobId) body.set("generationJobId", generationJobId);
    if (resultId) body.set("resultId", resultId);
    const submittedAt = generationJobId
      ? submitTimesByJobRef.current.get(generationJobId)
      : pendingTurnRef.current?.submittedAt;
    if (submittedAt) body.set("submittedAt", String(submittedAt));
    for (const [name, value] of Object.entries(metadata)) body.set(name, String(value));
    void fetch(window.location.pathname, { method: "POST", body, credentials: "same-origin", keepalive: true });
  }, []);

  const markOptimisticVisible = useCallback((field: "optimisticVisibleAt" | "referencePreviewVisibleAt") => {
    const current = pendingTurnRef.current;
    if (!current || current[field]) return;
    const occurredAt = Date.now();
    const next = { ...current, [field]: occurredAt };
    pendingTurnRef.current = next;
    setPendingTurn(next);
    if (next.generationJobId) {
      emitLatency(
        field === "optimisticVisibleAt" ? "OPTIMISTIC_TURN_VISIBLE" : "REFERENCE_PREVIEW_VISIBLE",
        next.generationJobId,
        null,
        { attachmentCount: next.attachments.length },
        occurredAt,
      );
    }
  }, [emitLatency]);

  useEffect(() => {
    if (!isInFlight) return;
    const poll = () => {
      if (statusFetcher.state === "idle") statusFetcher.submit({ intent: "poll-generation-status" }, { method: "POST" });
    };
    poll();
    const id = window.setInterval(poll, 1000);
    return () => window.clearInterval(id);
  }, [isInFlight, statusFetcher]);

  // A status snapshot gives the active image priority immediately. Once all
  // work is terminal, refresh the canonical conversation history once.
  useEffect(() => {
    if (!polledJobs || hasActiveGeneration(polledJobs)) return;
    revalidator.revalidate();
  }, [polledJobs, revalidator]);

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

  const isSending = messageFetcher.state !== "idle";
  const optimisticTurn = pendingTurn && !optimisticTurnReconciled ? pendingTurn : null;
  const insufficientCredits =
    messageFetcher.data && !messageFetcher.data.ok && "reason" in messageFetcher.data && messageFetcher.data.reason === "insufficient_credits";

  useEffect(() => {
    const generationJobId = messageFetcher.data && messageFetcher.data.ok && "generationJobId" in messageFetcher.data ? messageFetcher.data.generationJobId : null;
    if (messageFetcher.state !== "idle" || typeof generationJobId !== "string") return;
    if (pendingTurnRef.current && !pendingTurnRef.current.generationJobId) {
      const next = { ...pendingTurnRef.current, generationJobId };
      pendingTurnRef.current = next;
      submitTimesByJobRef.current.set(generationJobId, next.submittedAt);
      setPendingTurn(next);
      emitLatency("USER_SUBMITTED", generationJobId, null, { attachmentCount: next.attachments.length }, next.submittedAt);
      if (next.optimisticVisibleAt) {
        emitLatency("OPTIMISTIC_TURN_VISIBLE", generationJobId, null, { attachmentCount: next.attachments.length }, next.optimisticVisibleAt);
      }
      if (next.referencePreviewVisibleAt) {
        emitLatency("REFERENCE_PREVIEW_VISIBLE", generationJobId, null, { attachmentCount: next.attachments.length }, next.referencePreviewVisibleAt);
      }
    }
    // Fetcher actions normally revalidate, but request a prompt first poll
    // so a durable result cannot wait behind unrelated navigation work.
    revalidator.revalidate();
  }, [emitLatency, messageFetcher.data, messageFetcher.state, revalidator]);

  useEffect(() => {
    if (!pendingTurn || !optimisticTurnReconciled) return;
    const jobId = pendingTurn.generationJobId;
    if (jobId) emitLatency("PERSISTED_TURN_VISIBLE", jobId, null, { attachmentCount: pendingTurn.attachments.length });
    releaseOptimisticAttachments(pendingTurn.attachments);
    pendingTurnRef.current = null;
  }, [emitLatency, optimisticTurnReconciled, pendingTurn]);


  useEffect(() => {
    emitLatency("LOADER_COMPLETED", null, null, {
      loaderDurationMs: telemetry.loaderDurationMs,
      resultSigningMs: telemetry.resultSigningMs,
      resultSigningCount: telemetry.resultSigningCount,
      resultCount: telemetry.historicalResultCount,
    });
  }, [emitLatency, telemetry.historicalResultCount, telemetry.loaderDurationMs, telemetry.resultSigningCount, telemetry.resultSigningMs]);

  useEffect(() => {
    for (const job of observedJobs) {
      if (job.progressStage === "COMPLETED" && job.results.length > 0) {
        emitLatency("QUALITY_TERMINAL_OBSERVED", job.id, job.results[0]?.id, { resultCount: job.results.length });
      }
    }
  }, [emitLatency, observedJobs]);

  useEffect(() => () => {
    if (pendingTurnRef.current) releaseOptimisticAttachments(pendingTurnRef.current.attachments);
  }, []);

  useEffect(() => {
    if (optimisticTurn) markOptimisticVisible("optimisticVisibleAt");
  }, [markOptimisticVisible, optimisticTurn]);

  // Keep a newly submitted turn visible, but never repeatedly pull a
  // merchant away from earlier conversation history while they are reading.
  useEffect(() => {
    if (!shouldFollowTranscriptRef.current) return;
    transcriptEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, optimisticTurn?.id, latestJob?.updatedAt]);

  function submitMessage(text: string, files: File[] = [], submittedAt = 0) {
    submitMessageWithAttachments(text, files.map((file) => ({ file, previewUrl: "" })), submittedAt);
  }

  function submitMessageWithAttachments(text: string, attachments: ComposerAttachment[] = [], submittedAt = 0) {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || isSending) return;
    const formData = new FormData();
    formData.set("intent", "send-message");
    formData.set("message", trimmed);
    attachments.forEach(({ file }) => formData.append("images", file));
    if (pendingTurnRef.current) releaseOptimisticAttachments(pendingTurnRef.current.attachments);
    const nextPendingTurn: PendingStudioTurn = {
      id: globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`,
      content: trimmed || "Create a clean, professional product photo from this image.",
      attachments,
      submittedAt: submittedAt > 0 ? submittedAt : Date.now(),
    };
    pendingTurnRef.current = nextPendingTurn;
    setPendingTurn(nextPendingTurn);
    messageFetcher.submit(formData, { method: "POST", encType: "multipart/form-data" });
  }

  function focusComposer() {
    document.querySelector<HTMLTextAreaElement>(".studio-chat-composer textarea")?.focus();
  }

  return (
    <div className="studio-conv">
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

        <div
          className="studio-transcript"
          onScroll={(event) => {
            const element = event.currentTarget;
            shouldFollowTranscriptRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
          }}
        >
          {messages.length === 0 && (
            <p className="studio-canvas-placeholder" style={{ padding: 0 }}>
              Every request keeps your reference image (if any) intact unless you ask otherwise.
            </p>
          )}
          {messages.map((message) => (
            <div key={message.id} className="studio-turn" data-role={message.role === "SYSTEM" ? "ASSISTANT" : message.role}>
            <div className="studio-msg" data-role={message.role === "SYSTEM" ? "ASSISTANT" : message.role}>
              {message.role === "USER" && attachmentsForMessage(message.attachments).length > 0 && (
                <div className="studio-message-attachments">
                  {attachmentsForMessage(message.attachments).map((attachment) => (
                    <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer" className="studio-message-attachment">
                      <img src={attachment.url} alt="Reference attached to this request" />
                    </a>
                  ))}
                </div>
              )}
              <div className="studio-message-content">{renderMessageContent(message.content)}</div>
            </div>
            {message.role === "ASSISTANT" && message.generationJobId && (() => {
              const turnJob = observedJobs.find((job) => job.id === message.generationJobId);
              const turnResult = turnJob?.results.find((result) => result.id === session.currentResultId) ?? turnJob?.results[turnJob.results.length - 1];
              const active = turnJob && isGenerationActiveStage(turnJob.progressStage);
              if (!turnJob) return null;
              return <>
                <div className="studio-turn-generation" data-loading={active && !isResultRenderable(turnJob.results.length) || undefined}>
                  {active && !isResultRenderable(turnJob.results.length) && <StudioGenerationLoading title={jobStatusPhrase(turnJob.progressStage, turnJob.results.length || 1)} stage={turnJob.progressStage as Exclude<GenerationProgressStage, "COMPLETED" | "FAILED">} />}
                  {turnJob.status === "FAILED" && <div className="studio-turn-error" role="status">{turnJob.errorMessage ?? "That request could not be completed. Your prompt and references are still here."}</div>}
                  {turnResult?.url && (
                    <StudioResultImage
                      jobId={turnJob.id}
                      resultId={turnResult.id}
                      url={turnResult.url}
                      onTelemetry={(event, metadata) => emitLatency(event, turnJob.id, turnResult.id, {
                        resultCount: turnJob.results.length,
                        ...metadata,
                      })}
                    />
                  )}
                  {active && turnResult?.url && (
                    <div className="studio-result-quality-check" role="status" aria-live="polite">
                      <span className="studio-dot-pulse" aria-hidden="true" />
                      {jobStatusPhrase(turnJob.progressStage, turnJob.results.length || 1)}
                    </div>
                  )}
                </div>
                {turnResult?.url && (
                  <div className="studio-turn-result-meta">
                    {turnJob.results.length > 1 && (
                      <div className="studio-turn-versions" aria-label="Available variations">
                        {turnJob.results.map((result, index) => (
                          <button
                            key={result.id}
                            type="button"
                            className="studio-version-thumb"
                            data-selected={result.id === turnResult.id}
                            aria-label={`Show variation ${index + 1}${result.id === turnResult.id ? " (currently shown)" : ""}`}
                            onClick={() => selectFetcher.submit({ intent: "select-result", resultId: result.id }, { method: "POST" })}
                          >
                            {result.url && <img src={result.url} alt="" />}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="studio-turn-result-actions">
                      <a className="studio-btn" data-variant="primary" href={turnResult.url} target="_blank" rel="noreferrer" download="creation.png">
                        Download
                      </a>
                      <button type="button" className="studio-btn" onClick={focusComposer} disabled={isSending}>Edit / Continue</button>
                      <details className="studio-more-actions">
                        <summary>More actions</summary>
                        <div className="studio-secondary-actions">
                          <button type="button" className="studio-btn" onClick={() => submitMessage("Give me another variation.")} disabled={isSending}>Variation</button>
                          <button type="button" className="studio-btn" onClick={() => submitMessage("Regenerate this.")} disabled={isSending}>Regenerate</button>
                          <button type="button" className="studio-btn" disabled={turnResult.reviewStatus === "APPROVED"} onClick={() => reviewFetcher.submit({ intent: "review", resultId: turnResult.id, decision: "APPROVED" }, { method: "POST" })}>Approve</button>
                          <button type="button" className="studio-btn" data-variant="danger" disabled={turnResult.reviewStatus === "REJECTED"} onClick={() => reviewFetcher.submit({ intent: "review", resultId: turnResult.id, decision: "REJECTED" }, { method: "POST" })}>Reject</button>
                          <button type="button" className="studio-btn" onClick={() => feedbackFetcher.submit({ intent: "feedback", resultId: turnResult.id, signal: "positive" }, { method: "POST" })}>Love this style</button>
                          <button type="button" className="studio-btn" onClick={() => feedbackFetcher.submit({ intent: "feedback", resultId: turnResult.id, signal: "negative" }, { method: "POST" })}>Not my style</button>
                        </div>
                      </details>
                    </div>
                    <p className="studio-result-confirmation">Your image is ready. Continue with a refinement or start a new direction below.</p>
                  </div>
                )}
              </>;
            })()}
            </div>
          ))}
          {optimisticTurn && (
            <div className="studio-optimistic-turn">
              <div className="studio-msg studio-msg-pending" data-role="USER">
                {optimisticTurn.attachments.length > 0 && (
                  <div className="studio-message-attachments">
                    {optimisticTurn.attachments.map((attachment) => (
                      <div key={attachment.previewUrl} className="studio-message-attachment">
                        <img
                          src={attachment.previewUrl}
                          alt="Reference attached to this request"
                          onLoad={() => markOptimisticVisible("referencePreviewVisibleAt")}
                        />
                      </div>
                    ))}
                  </div>
                )}
                <div className="studio-message-content">{renderMessageContent(optimisticTurn.content)}</div>
              </div>
              <div className="studio-msg studio-msg-pending" data-role="ASSISTANT">I&rsquo;ve got it — I&rsquo;m shaping this into your next creative direction.</div>
              <div className="studio-turn-generation" data-loading="true"><StudioGenerationLoading title="Starting your creative request…" stage="PREPARING" /></div>
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
            <div className="studio-follow-up-suggestions" aria-label="Conversation suggestions">
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
          <Composer disabled={isSending} busy={isSending} onSubmit={submitMessage} onSubmitWithAttachments={submitMessageWithAttachments} placeholder="Continue this creative…" />
        </div>
      </section>
    </div>
  );
}
