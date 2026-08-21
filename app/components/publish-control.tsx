/**
 * Publish control — a shared "Ready / Publishing / Published / Failed"
 * UI + action for one approved result, used by both
 * app/routes/app.products.$id.tsx (Generation/Processing results) and
 * app/routes/app.store-visuals.$jobId.tsx (Store Visual results). See
 * docs/publishing.md "Review experience".
 *
 * Deliberately separate from Approve/Reject — publishing is never
 * triggered automatically by approval (see docs/publishing.md "Approval
 * and publishing are separate concepts"). Only rendered/enabled once a
 * result is APPROVED; the caller decides whether to render this at all.
 *
 * Submits to whichever route currently renders it (no explicit `action`
 * prop) — every route using this component must implement a
 * `request-publish` action intent that calls
 * services/publishing/request-publish.server.ts's `requestPublish`.
 */
import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

export interface PublishCandidateProduct {
  productId: string;
  title: string;
}

export interface PublishStatus {
  status: "PENDING" | "QUEUED" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  shopifyMediaId: string | null;
  errorMessage: string | null;
}

const STATUS_LABEL: Record<PublishStatus["status"], string> = {
  PENDING: "Publishing…",
  QUEUED: "Publishing…",
  PROCESSING: "Publishing…",
  SUCCEEDED: "Published",
  FAILED: "Publish failed",
  CANCELLED: "Publish cancelled",
};

const STATUS_TONE: Record<PublishStatus["status"], "info" | "success" | "critical" | "warning"> = {
  PENDING: "info",
  QUEUED: "info",
  PROCESSING: "info",
  SUCCEEDED: "success",
  FAILED: "critical",
  CANCELLED: "warning",
};

interface PublishActionResult {
  ok: boolean;
  error?: string;
}

export function PublishControl({
  sourceType,
  sourceResultId,
  candidateProducts,
  publishStatus,
}: {
  sourceType: "GENERATION_RESULT" | "PROCESSING_RESULT" | "STORE_VISUAL_RESULT";
  sourceResultId: string;
  candidateProducts: PublishCandidateProduct[];
  publishStatus: PublishStatus | null;
}) {
  const fetcher = useFetcher<PublishActionResult>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [targetProductId, setTargetProductId] = useState(candidateProducts[0]?.productId ?? "");

  const isSubmitting = fetcher.state !== "idle";
  const isInFlight = publishStatus?.status === "PENDING" || publishStatus?.status === "QUEUED" || publishStatus?.status === "PROCESSING";

  useEffect(() => {
    if (fetcher.data && !fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error ?? "Couldn't start publishing.", { isError: true });
    } else if (fetcher.data?.ok) {
      shopify.toast.show("Publishing started");
      // `requestPublish` creates the PublishingJob row (at minimum
      // QUEUED) synchronously before returning — the actual publish then
      // runs asynchronously on the worker. One immediate revalidate here
      // picks up that real in-flight status, and the effect below takes
      // over polling from it every 3s until it reaches a terminal state.
      // No local countdown state needed — same "poll while genuinely in
      // flight per the loader's own data" pattern as
      // app.processing.$batchId.tsx.
      revalidator.revalidate();
    }
  }, [fetcher.data, shopify, revalidator]);

  useEffect(() => {
    if (!isInFlight) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [isInFlight, revalidator]);

  if (candidateProducts.length === 0) {
    return (
      <s-text color="subdued">Publishing isn&rsquo;t available — this result has no associated product.</s-text>
    );
  }

  const handlePublish = () => {
    fetcher.submit(
      { intent: "request-publish", sourceType, sourceResultId, targetProductId },
      { method: "POST" },
    );
  };

  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      {publishStatus && (
        <s-badge tone={STATUS_TONE[publishStatus.status]}>{STATUS_LABEL[publishStatus.status]}</s-badge>
      )}

      {candidateProducts.length > 1 && !isInFlight && publishStatus?.status !== "SUCCEEDED" && (
        <s-select
          label="Publish to"
          labelAccessibilityVisibility="exclusive"
          value={targetProductId}
          onChange={(event: Event) => setTargetProductId((event.currentTarget as HTMLSelectElement).value)}
        >
          {candidateProducts.map((p) => (
            <s-option key={p.productId} value={p.productId}>
              {p.title}
            </s-option>
          ))}
        </s-select>
      )}

      {publishStatus?.status !== "SUCCEEDED" && !isInFlight && (
        <s-button
          variant="tertiary"
          onClick={handlePublish}
          disabled={isSubmitting || !targetProductId}
          {...(isSubmitting ? { loading: true } : {})}
        >
          {publishStatus?.status === "FAILED" ? "Retry publish" : "Publish"}
        </s-button>
      )}
    </s-stack>
  );
}
