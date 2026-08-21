/**
 * Batch lifestyle generation progress + result review (Phase 5) — see
 * docs/lifestyle-generation.md "Batch generation" and "Review UI".
 * Mirrors app/routes/app.processing.$batchId.tsx structurally (see that
 * file's module doc comment for why polling is unconditional here rather
 * than the product-detail page's click-then-await pattern: this page is
 * always reached via a server redirect right after the batch was
 * created).
 */
import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import { TenantMismatchError } from "../../lib/auth";
import { getGenerationBatchSummary } from "../../services/generation/batch.server";
import {
  createAndEnqueueGenerationJob,
  reviewGenerationResult,
  getGeneration,
  GenerationResultNotFoundError,
  ProductNotFoundError,
} from "../../services/generation/request-generation.server";
import type { GenerationJobRow, GenerationResultRow } from "../../db/repositories/generation-job.repository";
import type { GenerationPlan } from "../../services/generation/schema";

const NOT_FOUND_RESPONSE = () => new Response("Batch not found", { status: 404 });
const GENERIC_ERROR = "Couldn't complete that action right now. Please try again.";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);

  let summary: Awaited<ReturnType<typeof getGenerationBatchSummary>>;
  try {
    summary = await getGenerationBatchSummary(context, params.batchId!);
  } catch (error) {
    if (error instanceof TenantMismatchError) {
      // Same "indistinguishable from not-found" handling used throughout
      // this app — see the Phase 0/1 security audit ("existence oracle"
      // finding).
      throw NOT_FOUND_RESPONSE();
    }
    throw error;
  }
  if (!summary) throw NOT_FOUND_RESPONSE();

  return { summary };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "review") {
    const resultId = formData.get("resultId");
    const decision = formData.get("decision");
    if (typeof resultId !== "string" || (decision !== "APPROVED" && decision !== "REJECTED")) {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      await reviewGenerationResult(context, resultId, decision);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof GenerationResultNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  if (intent === "regenerate") {
    const jobId = formData.get("jobId");
    if (typeof jobId !== "string") {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      // Looked up server-side (never trusting a client-supplied product/
      // media) — the new request mirrors the EXACT product/source images/
      // generationType the original job used, with no preset re-applied
      // (falls back to category-aware defaults — a batch has no per-job
      // preset picker), and stays in the same batch (see
      // services/generation/request-generation.server.ts's
      // `createAndEnqueueGenerationJob`, the shared primitive this reuses
      // directly).
      const original = await getGeneration(context, jobId);
      if (!original) throw NOT_FOUND_RESPONSE();

      await createAndEnqueueGenerationJob(context, {
        productId: original.productId,
        generationType: original.type,
        sourceMediaIds: original.sourceMediaIds,
        batchId: original.batchId ?? undefined,
      });
      return { ok: true as const };
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof ProductNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  return { ok: false as const, error: "Unknown action." };
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Queued",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  PENDING: "info",
  QUEUED: "info",
  PROCESSING: "info",
  SUCCEEDED: "success",
  FAILED: "critical",
  CANCELLED: "warning",
};

const GENERATION_TYPE_LABEL: Record<string, string> = {
  PRODUCT_CLEANUP: "Product cleanup",
  LIFESTYLE: "Lifestyle",
};

export default function GenerationBatch() {
  const { summary } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const reviewFetcher = useFetcher<typeof action>();
  const regenerateFetcher = useFetcher<typeof action>();

  const { progress } = summary;
  const isTerminal = progress.pending + progress.queued + progress.processing === 0;
  const completed = progress.succeeded + progress.failed + progress.cancelled;
  const percent = progress.total > 0 ? Math.round((completed / progress.total) * 100) : 0;

  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [isTerminal, revalidator]);

  useEffect(() => {
    if (reviewFetcher.data && !reviewFetcher.data.ok) {
      shopify.toast.show(reviewFetcher.data.error, { isError: true });
    }
  }, [reviewFetcher.data, shopify]);

  useEffect(() => {
    if (regenerateFetcher.data?.ok) {
      shopify.toast.show("Regeneration started");
    } else if (regenerateFetcher.data && !regenerateFetcher.data.ok) {
      shopify.toast.show(regenerateFetcher.data.error, { isError: true });
    }
  }, [regenerateFetcher.data, shopify]);

  return (
    <s-page
      heading={`Generation batch — ${GENERATION_TYPE_LABEL[summary.generationType] ?? summary.generationType}`}
    >
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>

      <s-section heading="Progress">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={isTerminal ? (progress.failed > 0 ? "warning" : "success") : "info"}>
              {isTerminal ? "Complete" : "In progress"}
            </s-badge>
            <s-text>
              {completed} of {progress.total} completed ({percent}%)
            </s-text>
          </s-stack>
          <s-stack direction="inline" gap="large">
            <s-text color="subdued">Queued: {progress.pending + progress.queued}</s-text>
            <s-text color="subdued">Processing: {progress.processing}</s-text>
            <s-text color="subdued">Succeeded: {progress.succeeded}</s-text>
            <s-text color="subdued">Failed: {progress.failed}</s-text>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Results">
        {summary.jobs.length === 0 ? (
          <s-paragraph color="subdued">No jobs in this batch.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="large">
            {summary.jobs.map((job) => (
              <GenerationJobCard
                key={job.id}
                job={job}
                onReview={(resultId, decision) =>
                  reviewFetcher.submit({ intent: "review", resultId, decision }, { method: "POST" })
                }
                onRegenerate={() => regenerateFetcher.submit({ intent: "regenerate", jobId: job.id }, { method: "POST" })}
                isRegenerating={regenerateFetcher.state !== "idle"}
              />
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

function GenerationJobCard({
  job,
  onReview,
  onRegenerate,
  isRegenerating,
}: {
  job: GenerationJobRow;
  onReview: (resultId: string, decision: "APPROVED" | "REJECTED") => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
}) {
  const latestResult: GenerationResultRow | undefined = job.results[job.results.length - 1];
  const plan = job.plan as unknown as GenerationPlan;
  const original = plan.sourceImages[0];

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text type="strong">{job.product.title}</s-text>
            <s-badge tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</s-badge>
          </s-stack>
          <s-text color="subdued">{new Date(job.createdAt).toLocaleString()}</s-text>
        </s-stack>

        {job.status === "FAILED" && (
          <s-banner tone="critical">
            <s-paragraph>{job.errorMessage ?? "Generation failed."}</s-paragraph>
          </s-banner>
        )}

        <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Original</s-text>
            {original ? (
              <s-image src={original.url} alt={original.altText ?? job.product.title} />
            ) : (
              <s-paragraph color="subdued">Not available.</s-paragraph>
            )}
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Generated</s-text>
            {latestResult ? (
              <s-image src={latestResult.url ?? undefined} alt={`Generated — ${job.product.title}`} />
            ) : (
              <s-paragraph color="subdued">Not available yet.</s-paragraph>
            )}
          </s-stack>
        </s-grid>

        {latestResult && (
          <>
            <s-text color="subdued">
              {latestResult.format ?? "—"}
              {latestResult.width && latestResult.height ? ` · ${latestResult.width}×${latestResult.height}` : ""} ·{" "}
              {latestResult.reviewStatus === "APPROVED"
                ? "Approved"
                : latestResult.reviewStatus === "REJECTED"
                  ? "Rejected"
                  : "Not reviewed"}
            </s-text>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="tertiary"
                disabled={latestResult.reviewStatus === "APPROVED"}
                onClick={() => onReview(latestResult.id, "APPROVED")}
              >
                Approve
              </s-button>
              <s-button
                variant="tertiary"
                tone="critical"
                disabled={latestResult.reviewStatus === "REJECTED"}
                onClick={() => onReview(latestResult.id, "REJECTED")}
              >
                Reject
              </s-button>
              <s-button variant="tertiary" onClick={onRegenerate} {...(isRegenerating ? { loading: true } : {})}>
                Regenerate
              </s-button>
            </s-stack>
          </>
        )}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
