/**
 * Store visual progress + result review — structural mirror of
 * app/routes/app.generation.$batchId.tsx (single job, not a batch, since
 * store visuals aren't created in batches this phase — see
 * docs/store-visuals.md). Reached via a server redirect right after
 * app/routes/app.store-visuals._index.tsx's create action, so polling is
 * unconditional the same way that file's module doc comment explains.
 */
import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useNavigate, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import { TenantMismatchError } from "../../lib/auth";
import { withResultsSanitizedForClient } from "../../lib/storage";
import {
  getStoreVisual,
  reviewStoreVisualResult,
  requestStoreVisual,
  StoreVisualResultNotFoundError,
} from "../../services/store-visuals/request-store-visual.server";
import { startCreativeSession, ProductNotFoundError as CreativeStudioProductNotFoundError } from "../../services/creative-studio/session.server";
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
import type { StoreVisualJobRow, StoreVisualResultRow } from "../../db/repositories/store-visual-job.repository";
import type { StoreVisualPlan } from "../../services/store-visuals/schema";

const NOT_FOUND_RESPONSE = () => new Response("Store visual not found", { status: 404 });
const GENERIC_ERROR = "Couldn't complete that action right now. Please try again.";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);

  let job: StoreVisualJobRow | null;
  try {
    job = await getStoreVisual(context, params.jobId!);
  } catch (error) {
    if (error instanceof TenantMismatchError) {
      throw NOT_FOUND_RESPONSE();
    }
    throw error;
  }
  if (!job) throw NOT_FOUND_RESPONSE();

  const latestResult = job.results[job.results.length - 1];
  const publishStatus = latestResult
    ? await getLatestPublishStatus(context, "STORE_VISUAL_RESULT", latestResult.id)
    : null;

  return { job: withResultsSanitizedForClient(job), publishStatus };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
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
      await reviewStoreVisualResult(context, resultId, decision);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof StoreVisualResultNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  if (intent === "regenerate") {
    try {
      // Looked up server-side (never trusting a client-supplied type/
      // products) — the new request mirrors the EXACT visual type and
      // product references the original job used. No preset re-applied
      // (falls back to generic styling) — this page has no preset
      // picker, mirroring app.generation.$batchId.tsx's identical
      // "regenerate uses no per-job preset picker" reasoning.
      const original = await getStoreVisual(context, params.jobId!);
      if (!original) throw NOT_FOUND_RESPONSE();

      const originalPlan = original.plan as unknown as StoreVisualPlan;
      const job = await requestStoreVisual(context, {
        visualType: original.type,
        productIds: original.products.map((p) => p.productId),
        aspectRatio: originalPlan.aspectRatio,
      });
      return { ok: true as const, jobId: job.id };
    } catch (error) {
      if (error instanceof TenantMismatchError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  if (intent === "start-creative-session") {
    const productId = formData.get("productId");
    const sourceResultId = formData.get("sourceResultId");
    if (typeof productId !== "string" || typeof sourceResultId !== "string") {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      const session = await startCreativeSession(context, {
        productId,
        sourceType: "STORE_VISUAL_RESULT",
        sourceResultId,
      });
      return redirect(`/app/creative/${session.id}`);
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof CreativeStudioProductNotFoundError) {
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
      await requestPublish(context, { sourceType: "STORE_VISUAL_RESULT", sourceResultId, targetProductId });
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

const VISUAL_TYPE_LABEL: Record<string, string> = {
  HOMEPAGE_HERO: "Homepage hero",
  COLLECTION_BANNER: "Collection banner",
  STORE_CTA: "Store call-to-action",
};

export default function StoreVisualDetail() {
  const { job, publishStatus } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const shopify = useAppBridge();
  const reviewFetcher = useFetcher<typeof action>();
  const regenerateFetcher = useFetcher<typeof action>();
  const creativeStudioFetcher = useFetcher<typeof action>();

  const isTerminal = job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "CANCELLED";

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
      if ("jobId" in regenerateFetcher.data) {
        navigate(`/app/store-visuals/${regenerateFetcher.data.jobId}`);
      }
    } else if (regenerateFetcher.data && !regenerateFetcher.data.ok) {
      shopify.toast.show(regenerateFetcher.data.error, { isError: true });
    }
  }, [regenerateFetcher.data, shopify, navigate]);

  useEffect(() => {
    if (creativeStudioFetcher.data && !creativeStudioFetcher.data.ok) {
      shopify.toast.show(creativeStudioFetcher.data.error, { isError: true });
    }
  }, [creativeStudioFetcher.data, shopify]);

  const plan = job.plan as unknown as StoreVisualPlan;
  const latestResult: StoreVisualResultRow | undefined = job.results[job.results.length - 1];
  const isRegenerating = regenerateFetcher.state !== "idle";
  // Creative Studio sessions are always product-scoped (see
  // docs/creative-studio.md "Architecture") — a fully generic store
  // visual with no featured product has nothing to continue editing
  // against, so "Continue editing" isn't offered there (mirrors
  // PublishControl's identical "no associated product" graceful
  // degradation).
  const firstFeaturedProductId = job.products[0]?.productId ?? null;

  return (
    <s-page heading={`${VISUAL_TYPE_LABEL[job.type] ?? job.type}`}>
      <s-link slot="breadcrumb-actions" href="/app/assets">
        AI Assets
      </s-link>

      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</s-badge>
            <s-text color="subdued">{new Date(job.createdAt).toLocaleString()}</s-text>
            <s-text color="subdued">{plan.aspectRatio}</s-text>
          </s-stack>

          {job.products.length > 0 && (
            <s-text color="subdued">Featuring: {job.products.map((p) => p.product.title).join(", ")}</s-text>
          )}

          {job.status === "FAILED" && (
            <s-banner tone="critical">
              <s-paragraph>{job.errorMessage ?? "Generation failed."}</s-paragraph>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Result">
        {!latestResult ? (
          <s-paragraph color="subdued">Not available yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {latestResult.url && <s-image src={latestResult.url} alt={`${VISUAL_TYPE_LABEL[job.type] ?? job.type} result`} />}
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
                onClick={() =>
                  reviewFetcher.submit({ intent: "review", resultId: latestResult.id, decision: "APPROVED" }, { method: "POST" })
                }
              >
                Approve
              </s-button>
              <s-button
                variant="tertiary"
                tone="critical"
                disabled={latestResult.reviewStatus === "REJECTED"}
                onClick={() =>
                  reviewFetcher.submit({ intent: "review", resultId: latestResult.id, decision: "REJECTED" }, { method: "POST" })
                }
              >
                Reject
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => regenerateFetcher.submit({ intent: "regenerate" }, { method: "POST" })}
                {...(isRegenerating ? { loading: true } : {})}
              >
                Regenerate
              </s-button>
              {firstFeaturedProductId && (
                <s-button
                  variant="tertiary"
                  onClick={() =>
                    creativeStudioFetcher.submit(
                      { intent: "start-creative-session", productId: firstFeaturedProductId, sourceResultId: latestResult.id },
                      { method: "POST" },
                    )
                  }
                  {...(creativeStudioFetcher.state !== "idle" ? { loading: true } : {})}
                >
                  Continue editing
                </s-button>
              )}
            </s-stack>

            {latestResult.reviewStatus === "APPROVED" && (
              <PublishControl
                sourceType="STORE_VISUAL_RESULT"
                sourceResultId={latestResult.id}
                candidateProducts={job.products.map((p) => ({ productId: p.productId, title: p.product.title }))}
                publishStatus={publishStatus}
              />
            )}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
