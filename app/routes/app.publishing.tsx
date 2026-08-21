/**
 * Publishing — shop-wide publish history (services/publishing/, see
 * docs/publishing.md). Read-only; publishing itself is always initiated
 * from a result's own review card (product detail, store visual detail —
 * see app/components/publish-control.tsx), never from this page.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireAdminContext } from "../../services/shopify";
import { listPublishingHistory } from "../../services/publishing/request-publish.server";
import type { PublishingStatusValue } from "../../services/publishing/types";

const SOURCE_TYPE_LABEL: Record<string, string> = {
  GENERATION_RESULT: "Product generation",
  PROCESSING_RESULT: "Product processing",
  STORE_VISUAL_RESULT: "Store visual",
};

const STATUS_LABEL: Record<PublishingStatusValue, string> = {
  PENDING: "Queued",
  QUEUED: "Queued",
  PROCESSING: "Publishing…",
  SUCCEEDED: "Published",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const STATUS_TONE: Record<PublishingStatusValue, "info" | "success" | "critical" | "warning"> = {
  PENDING: "info",
  QUEUED: "info",
  PROCESSING: "info",
  SUCCEEDED: "success",
  FAILED: "critical",
  CANCELLED: "warning",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page")) || 1;

  const history = await listPublishingHistory(context, {}, page);
  return { history };
};

export default function Publishing() {
  const { history } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(history.total / history.pageSize));
  const goToPage = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    setSearchParams(next);
  };

  return (
    <s-page heading="Publishing">
      <s-section heading="Publish history">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Every publish attempt from an approved result to a Shopify product&rsquo;s media gallery, across product
            generation, processing, and store visuals.
          </s-text>

          {history.jobs.length === 0 ? (
            <s-paragraph color="subdued">
              Nothing published yet. Publish an approved result from its review card on a product or store visual
              page.
            </s-paragraph>
          ) : (
            <s-table
              paginate
              hasNextPage={history.page < totalPages}
              hasPreviousPage={history.page > 1}
              onNextPage={() => goToPage(history.page + 1)}
              onPreviousPage={() => goToPage(history.page - 1)}
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="secondary">Source</s-table-header>
                <s-table-header listSlot="secondary">Status</s-table-header>
                <s-table-header listSlot="secondary">Date</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {history.jobs.map((job) => (
                  <s-table-row key={job.id}>
                    <s-table-cell>
                      <s-link href={`/app/products/${job.targetProductId}`}>{job.targetProduct.title}</s-link>
                    </s-table-cell>
                    <s-table-cell>{SOURCE_TYPE_LABEL[job.sourceType] ?? job.sourceType}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</s-badge>
                      {job.status === "FAILED" && job.errorMessage && (
                        <s-text color="subdued"> — {job.errorMessage}</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>{new Date(job.createdAt).toLocaleString()}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
