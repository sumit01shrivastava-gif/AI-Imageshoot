/**
 * Usage — a merchant-facing view of this shop's usage ledger
 * (services/usage/usage-accounting.server.ts, docs/usage.md). Shows
 * current-period activity counts and recent events — the raw operation
 * log. Credit balances/plan/billing status live on the companion
 * /app/billing page (services/billing/, services/usage/entitlement.server.ts)
 * rather than being duplicated here; this page links there instead.
 */
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireAdminContext } from "../../services/shopify";
import { getUsageOverview } from "../../services/usage/usage-accounting.server";
import type { UsageOperationType } from "@prisma/client";

const OPERATION_LABEL: Record<UsageOperationType, string> = {
  PRODUCT_ANALYSIS: "Product analysis",
  IMAGE_GENERATION: "Image generation",
  IMAGE_PROCESSING: "Image processing",
  STORE_VISUAL_GENERATION: "Store visual generation",
};

const STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
};

const STATUS_TONE: Record<string, "success" | "critical"> = {
  SUCCEEDED: "success",
  FAILED: "critical",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const url = new URL(request.url);
  const page = Number(url.searchParams.get("page")) || 1;

  const overview = await getUsageOverview(context, page);
  return { overview };
};

function formatPeriodLabel(since: Date | string): string {
  return new Date(since).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function Usage() {
  const { overview } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(overview.recentEvents.total / overview.recentEvents.pageSize));
  const goToPage = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    setSearchParams(next);
  };

  const summaryByType = new Map(overview.summary.map((s) => [s.operationType, s]));

  return (
    <s-page heading="Usage">
      <s-section heading={`This period — ${formatPeriodLabel(overview.since)}`}>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued">A record of every AI operation this shop has run.</s-text>
            <s-link href="/app/billing">View plan, credits &amp; billing</s-link>
          </s-stack>

          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            {(Object.keys(OPERATION_LABEL) as UsageOperationType[]).map((type) => {
              const summary = summaryByType.get(type);
              return (
                <s-box key={type} padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
                  <s-stack direction="block" gap="small-200">
                    <s-text color="subdued">{OPERATION_LABEL[type]}</s-text>
                    <s-heading>{summary?.succeededCount ?? 0}</s-heading>
                    <s-text color="subdued">
                      {summary?.totalOutputCount ?? 0} output{(summary?.totalOutputCount ?? 0) === 1 ? "" : "s"}
                      {summary && summary.failedCount > 0 ? ` · ${summary.failedCount} failed` : ""}
                    </s-text>
                  </s-stack>
                </s-box>
              );
            })}
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Recent activity">
        {overview.recentEvents.events.length === 0 ? (
          <s-paragraph color="subdued">No usage recorded yet.</s-paragraph>
        ) : (
          <s-table
            paginate
            hasNextPage={overview.recentEvents.page < totalPages}
            hasPreviousPage={overview.recentEvents.page > 1}
            onNextPage={() => goToPage(overview.recentEvents.page + 1)}
            onPreviousPage={() => goToPage(overview.recentEvents.page - 1)}
          >
            <s-table-header-row>
              <s-table-header listSlot="primary">Operation</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header listSlot="secondary">Outputs</s-table-header>
              <s-table-header listSlot="secondary">Provider</s-table-header>
              <s-table-header listSlot="secondary">Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {overview.recentEvents.events.map((event) => (
                <s-table-row key={event.id}>
                  <s-table-cell>{OPERATION_LABEL[event.operationType]}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[event.status]}>{STATUS_LABEL[event.status]}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{event.outputCount}</s-table-cell>
                  <s-table-cell>{event.providerName ?? "—"}</s-table-cell>
                  <s-table-cell>{new Date(event.createdAt).toLocaleString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
