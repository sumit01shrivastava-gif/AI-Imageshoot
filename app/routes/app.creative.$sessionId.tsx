/**
 * The AI Creative Studio — a conversational, ChatGPT/Canva-style
 * image creation/editing workspace for one product, scoped to one
 * `CreativeSession`. See docs/creative-studio.md.
 *
 * Left: the canvas (current result, version thumbnails, review/publish
 * actions). Right: the conversation (message history, status, input).
 * Every generation request goes through `services/creative-studio/session.server.ts`'s
 * `sendCreativeMessage` — the merchant's own words are never sent to the
 * image provider directly (see that module's doc comment).
 */
import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import { TenantMismatchError } from "../../lib/auth";
import { withResultsSanitizedForClient } from "../../lib/storage";
import { logger } from "../../lib/logging/logger.server";
import {
  getCreativeSessionDetail,
  sendCreativeMessage,
  selectCreativeResult,
  reviewCreativeResult,
  CreativeSessionNotFoundError,
  EmptyMessageError,
  ProductNotAnalyzedError,
  MissingSourceImagesError,
  InsufficientCreditsError,
  GenerationResultNotFoundError,
} from "../../services/creative-studio/session.server";
import {
  requestPublish,
  getLatestPublishStatus,
  ResultNotApprovedError,
  InvalidPublishTargetError,
  AlreadyPublishedError,
  PublishInProgressError,
  InvalidPublishRequestError,
  PublishSourceNotFoundError,
} from "../../services/publishing/request-publish.server";
import { PublishControl } from "../components/publish-control";

const NOT_FOUND_RESPONSE = () => new Response("Creative session not found", { status: 404 });
const GENERIC_ERROR = "Couldn't complete that action right now. Please try again.";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);

  let detail: Awaited<ReturnType<typeof getCreativeSessionDetail>>;
  try {
    detail = await getCreativeSessionDetail(context, params.sessionId!);
  } catch (error) {
    if (error instanceof CreativeSessionNotFoundError || error instanceof TenantMismatchError) {
      throw NOT_FOUND_RESPONSE();
    }
    throw error;
  }

  const publishStatus = detail.session.currentResultId
    ? await getLatestPublishStatus(context, "GENERATION_RESULT", detail.session.currentResultId)
    : null;

  return {
    session: detail.session,
    messages: detail.messages,
    jobs: detail.jobs.map(withResultsSanitizedForClient),
    entitlement: detail.entitlement,
    publishStatus,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const sessionId = params.sessionId!;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "send-message") {
    const message = formData.get("message");
    if (typeof message !== "string") {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      const result = await sendCreativeMessage(context, sessionId, message);
      return { ok: true as const, generationJobId: result.generationJobId };
    } catch (error) {
      if (error instanceof CreativeSessionNotFoundError || error instanceof TenantMismatchError) {
        throw NOT_FOUND_RESPONSE();
      }
      if (
        error instanceof EmptyMessageError ||
        error instanceof ProductNotAnalyzedError ||
        error instanceof MissingSourceImagesError
      ) {
        return { ok: false as const, error: error.message };
      }
      if (error instanceof InsufficientCreditsError) {
        return { ok: false as const, error: error.message, reason: "insufficient_credits" as const };
      }
      logger.error("creative.send_message_failed", {
        shop: context.shop,
        sessionId,
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
        return { ok: false as const, error: "That result couldn't be found." };
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
      await reviewCreativeResult(context, resultId, decision);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof GenerationResultNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  if (intent === "request-publish") {
    const sourceResultId = formData.get("sourceResultId");
    const targetProductId = formData.get("targetProductId");
    if (typeof sourceResultId !== "string" || typeof targetProductId !== "string") {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      await requestPublish(context, { sourceType: "GENERATION_RESULT", sourceResultId, targetProductId });
      return { ok: true as const };
    } catch (error) {
      if (
        error instanceof ResultNotApprovedError ||
        error instanceof InvalidPublishTargetError ||
        error instanceof AlreadyPublishedError ||
        error instanceof PublishInProgressError ||
        error instanceof InvalidPublishRequestError
      ) {
        return { ok: false as const, error: error.message };
      }
      if (error instanceof PublishSourceNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  return { ok: false as const, error: "Unknown action." };
};

const EXAMPLE_PROMPTS = [
  "Put my product in a premium lifestyle scene",
  "Create a clean Amazon-style product image",
  "Change the background to a luxury marble bathroom",
  "Keep the product exactly the same and add a model holding it",
  "Make this look more premium",
  "Create 3 variations",
];

// Part 10's discrete, honest status phrases — derived from the existing
// GenerationStatus lifecycle, never a fake progress percentage.
function jobStatusPhrase(status: string, outputCount: number): string {
  if (status === "PENDING" || status === "QUEUED") return "Understanding your request…";
  if (status === "PROCESSING") return outputCount > 1 ? `Generating ${outputCount} variations…` : "Creating your image…";
  if (status === "SUCCEEDED") return "Your images are ready.";
  if (status === "FAILED") return "That request didn't work out.";
  return "";
}

export default function CreativeStudio() {
  const { session, messages, jobs, entitlement, publishStatus } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const messageFetcher = useFetcher<typeof action>();
  const selectFetcher = useFetcher<typeof action>();
  const reviewFetcher = useFetcher<typeof action>();
  const [draft, setDraft] = useState("");
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const latestJob = jobs[0] ?? null;
  const isInFlight = latestJob ? ["PENDING", "QUEUED", "PROCESSING"].includes(latestJob.status) : false;

  // Poll while the latest job is in flight — same established pattern as
  // every other async job page in this app (see e.g.
  // app.store-visuals.$jobId.tsx).
  useEffect(() => {
    if (!isInFlight) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [isInFlight, revalidator]);

  useEffect(() => {
    if (messageFetcher.data && !messageFetcher.data.ok) {
      shopify.toast.show(messageFetcher.data.error, { isError: true });
    }
  }, [messageFetcher.data, shopify]);

  useEffect(() => {
    if (selectFetcher.data && !selectFetcher.data.ok) {
      shopify.toast.show(selectFetcher.data.error, { isError: true });
    }
  }, [selectFetcher.data, shopify]);

  useEffect(() => {
    if (reviewFetcher.data && !reviewFetcher.data.ok) {
      shopify.toast.show(reviewFetcher.data.error, { isError: true });
    }
  }, [reviewFetcher.data, shopify]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const isSending = messageFetcher.state !== "idle";
  const insufficientCredits = messageFetcher.data && !messageFetcher.data.ok && "reason" in messageFetcher.data && messageFetcher.data.reason === "insufficient_credits";

  const currentResult = latestJob?.results.find((r) => r.id === session.currentResultId) ?? latestJob?.results[latestJob.results.length - 1] ?? null;

  const submitMessage = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isSending) return;
    // Cleared optimistically on submit, not on the fetcher's eventual
    // response — a chat input clearing the instant it's sent (rather
    // than waiting a round trip) is both the expected UX and avoids
    // calling setState from inside an effect reacting to fetcher.data.
    setDraft("");
    messageFetcher.submit({ intent: "send-message", message: trimmed }, { method: "POST" });
  };

  return (
    <s-page heading="Creative Studio">
      <s-link slot="breadcrumb-actions" href={`/app/products/${session.productId}`}>
        {session.product.title}
      </s-link>

      <s-grid gridTemplateColumns="3fr 2fr" gap="base">
        <s-section heading="Canvas">
          <s-stack direction="block" gap="base">
            {latestJob?.status === "FAILED" && (
              <s-banner tone="critical">
                <s-paragraph>{latestJob.errorMessage ?? "Generation failed."}</s-paragraph>
              </s-banner>
            )}

            {!currentResult ? (
              <s-paragraph color="subdued">
                Nothing generated yet — send an instruction to get started.
              </s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-200">
                {currentResult.url && <s-image src={currentResult.url} alt="Current Creative Studio result" />}
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-text color="subdued">
                    {currentResult.format ?? "—"}
                    {currentResult.width && currentResult.height ? ` · ${currentResult.width}×${currentResult.height}` : ""} ·{" "}
                    {currentResult.reviewStatus === "APPROVED" ? "Approved" : currentResult.reviewStatus === "REJECTED" ? "Rejected" : "Not reviewed"}
                  </s-text>
                  {currentResult.url && (
                    <s-link href={currentResult.url} target="_blank">
                      View full size
                    </s-link>
                  )}
                </s-stack>
              </s-stack>
            )}

            {latestJob && latestJob.results.length > 1 && (
              <s-stack direction="block" gap="small-200">
                <s-text color="subdued">Variations</s-text>
                <s-stack direction="inline" gap="small-200">
                  {latestJob.results.map((result, index) => (
                    <s-clickable
                      key={result.id}
                      onClick={() => selectFetcher.submit({ intent: "select-result", resultId: result.id }, { method: "POST" })}
                    >
                      <s-stack direction="block" gap="small-200" alignItems="center">
                        {result.url && <s-thumbnail src={result.url} alt={`Variation ${index + 1}`} size="small" />}
                        {result.id === currentResult?.id && <s-badge tone="info">Selected</s-badge>}
                      </s-stack>
                    </s-clickable>
                  ))}
                </s-stack>
              </s-stack>
            )}

            {currentResult && (
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="tertiary"
                  disabled={currentResult.reviewStatus === "APPROVED"}
                  onClick={() => reviewFetcher.submit({ intent: "review", resultId: currentResult.id, decision: "APPROVED" }, { method: "POST" })}
                >
                  Approve
                </s-button>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  disabled={currentResult.reviewStatus === "REJECTED"}
                  onClick={() => reviewFetcher.submit({ intent: "review", resultId: currentResult.id, decision: "REJECTED" }, { method: "POST" })}
                >
                  Reject
                </s-button>
                <s-button variant="tertiary" onClick={() => submitMessage("Regenerate this.")} {...(isSending ? { loading: true } : {})}>
                  Regenerate
                </s-button>
                <s-button variant="tertiary" onClick={() => submitMessage("Give me another variation.")} {...(isSending ? { loading: true } : {})}>
                  Create variation
                </s-button>
              </s-stack>
            )}

            {currentResult?.reviewStatus === "APPROVED" && (
              <PublishControl
                sourceType="GENERATION_RESULT"
                sourceResultId={currentResult.id}
                candidateProducts={[{ productId: session.productId, title: session.product.title }]}
                publishStatus={publishStatus}
              />
            )}
          </s-stack>
        </s-section>

        <s-section heading="Conversation">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              {entitlement.available} of {entitlement.limit} credits available this month (development allowance).
            </s-text>

            {messages.length === 0 ? (
              <s-stack direction="block" gap="small-200">
                <s-paragraph color="subdued">
                  Describe what you want — the product itself is always preserved exactly as-is unless you ask
                  otherwise. Try:
                </s-paragraph>
                <s-stack direction="block" gap="small-200">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <s-button key={prompt} variant="tertiary" onClick={() => submitMessage(prompt)}>
                      {prompt}
                    </s-button>
                  ))}
                </s-stack>
              </s-stack>
            ) : (
              <s-stack direction="block" gap="small-200">
                {messages.map((message) => (
                  <s-box
                    key={message.id}
                    padding="small-200"
                    borderRadius="base"
                    background={message.role === "USER" ? "subdued" : undefined}
                  >
                    <s-text color={message.role === "USER" ? undefined : "subdued"}>
                      {message.role === "USER" ? "You: " : "Studio: "}
                      {message.content}
                    </s-text>
                  </s-box>
                ))}
                {/* FAILED already gets its own, more specific banner
                    above (the merchant-safe errorMessage) — this line
                    covers the rest of the lifecycle, including the
                    terminal "Your images are ready." confirmation once
                    SUCCEEDED (Part 10) — it must NOT disappear the
                    moment a job finishes. */}
                {latestJob && latestJob.status !== "FAILED" && latestJob.status !== "CANCELLED" && (
                  <s-text color="subdued">{jobStatusPhrase(latestJob.status, latestJob.results.length || 1)}</s-text>
                )}
                <div ref={transcriptEndRef} />
              </s-stack>
            )}

            {insufficientCredits && (
              <s-banner tone="warning">
                <s-paragraph>{messageFetcher.data && !messageFetcher.data.ok ? messageFetcher.data.error : ""}</s-paragraph>
              </s-banner>
            )}

            <s-stack direction="inline" gap="base">
              <s-text-field
                label="Message"
                labelAccessibilityVisibility="exclusive"
                placeholder="Describe what you want…"
                value={draft}
                // `onInput` (fires on every keystroke), NOT `onChange`
                // (this component only dispatches a native `change` event
                // on blur) — a real, once-caught bug: gating the Send
                // button on live `draft` state while only listening for
                // `onChange` meant clicking Send directly after typing
                // (without first clicking/tabbing elsewhere) could never
                // actually enable the button, since a disabled button
                // can't itself receive the focus-shifting click that
                // would have triggered the blur. See
                // tests/e2e/creative-studio.spec.ts.
                onInput={(event: Event) => setDraft((event.currentTarget as HTMLInputElement).value)}
              />
              <s-button
                variant="primary"
                disabled={isSending || draft.trim().length === 0}
                {...(isSending ? { loading: true } : {})}
                onClick={() => submitMessage(draft)}
              >
                Send
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      </s-grid>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
