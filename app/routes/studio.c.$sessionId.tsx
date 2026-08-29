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
import { useFetcher, useLoaderData, useRevalidator, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
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
import { Composer } from "../components/composer";
import { StudioGenerationLoading } from "../components/studio-generation-loading";
import { generationProgressStage, hasActiveGeneration, isGenerationActiveStage, isResultRenderable, type GenerationProgressStage } from "../../services/generation/progress";

const NOT_FOUND_RESPONSE = () => new Response("Conversation not found", { status: 404 });
const GENERIC_ERROR = "I couldn't complete that action. Please try again.";

const SUGGESTION_CHIPS = [
  "Make the background darker",
  "Make it feel more cinematic",
  "Change this to 4:5",
  "Give me another variation",
  "Use more premium lighting",
];

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
        progressStage: generationProgressStage(sanitized.status, sanitized.results.length),
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
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const shouldFollowTranscriptRef = useRef(true);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  const latestJob = jobs[0] ?? null;
  const isInFlight = hasActiveGeneration(jobs);

  useEffect(() => {
    if (!isInFlight) return;
    const id = setInterval(() => revalidator.revalidate(), 1000);
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

  const isSending = messageFetcher.state !== "idle";
  const optimisticMessage = isSending ? pendingMessage : null;
  const insufficientCredits =
    messageFetcher.data && !messageFetcher.data.ok && "reason" in messageFetcher.data && messageFetcher.data.reason === "insufficient_credits";

  useEffect(() => {
    const generationJobId = messageFetcher.data && messageFetcher.data.ok && "generationJobId" in messageFetcher.data ? messageFetcher.data.generationJobId : null;
    if (messageFetcher.state !== "idle" || typeof generationJobId !== "string") return;
    // Fetcher actions normally revalidate, but request a prompt first poll
    // so a durable result cannot wait behind unrelated navigation work.
    revalidator.revalidate();
  }, [messageFetcher.data, messageFetcher.state, revalidator]);

  // Keep a newly submitted turn visible, but never repeatedly pull a
  // merchant away from earlier conversation history while they are reading.
  useEffect(() => {
    if (!shouldFollowTranscriptRef.current) return;
    transcriptEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, optimisticMessage, latestJob?.updatedAt]);

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
              const turnJob = jobs.find((job) => job.id === message.generationJobId);
              const turnResult = turnJob?.results.find((result) => result.id === session.currentResultId) ?? turnJob?.results[turnJob.results.length - 1];
              const active = turnJob && isGenerationActiveStage(turnJob.progressStage);
              if (!turnJob) return null;
              return <>
                <div className="studio-turn-generation">
                  {active && !isResultRenderable(turnJob.results.length) && <StudioGenerationLoading title={jobStatusPhrase(turnJob.progressStage, turnJob.results.length || 1)} stage={turnJob.progressStage as Exclude<GenerationProgressStage, "COMPLETED" | "FAILED">} />}
                  {turnJob.status === "FAILED" && <div className="studio-turn-error" role="status">{turnJob.errorMessage ?? "That request could not be completed. Your prompt and references are still here."}</div>}
                  {turnResult?.url && <img className="studio-turn-result" src={turnResult.url} alt="Generated result" />}
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
          {optimisticMessage && <div className="studio-msg studio-msg-pending" data-role="USER">{optimisticMessage}</div>}
          {optimisticMessage && (
            <div className="studio-optimistic-turn">
              <div className="studio-msg studio-msg-pending" data-role="ASSISTANT">I&rsquo;ve got it — I&rsquo;m shaping this into your next creative direction.</div>
              <div className="studio-turn-generation"><StudioGenerationLoading title="Starting your creative request…" stage="PREPARING" /></div>
            </div>
          )}
          {/* Must NOT disappear the moment a job finishes — SUCCEEDED
              gets its own confirmation line here too, not just while
              in flight (FAILED already has its own, more specific
              banner above). */}
          {(latestJob && latestJob.status !== "FAILED") && (
            <div className="studio-status-line" role="status" aria-live="polite">
              {isInFlight && <span className="studio-dot-pulse" aria-hidden="true" />}
              {jobStatusPhrase(latestJob.progressStage, latestJob.results.length || 1)}
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
          <Composer disabled={isSending} busy={isSending} onSubmit={submitMessage} placeholder="Continue this creative…" />
        </div>
      </section>
    </div>
  );
}
