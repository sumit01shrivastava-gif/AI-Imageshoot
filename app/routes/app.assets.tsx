/**
 * AI Assets — the shop-wide asset library. See
 * services/assets/asset-library.server.ts for the merge/filter/pagination
 * strategy and docs/asset-library.md. Read-only browsing + filtering;
 * review/approve/reject/regenerate stays on each result's own domain
 * detail page (product detail for GENERATION/PROCESSING,
 * /app/store-visuals/:jobId for STORE_VISUAL) — this page links out to
 * those rather than duplicating review actions inline.
 */
import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import { TenantMismatchError } from "../../lib/auth";
import { listAssetLibrary } from "../../services/assets/asset-library.server";
import { ASSET_KINDS, type AssetKind, type AssetItem } from "../../services/assets/types";
import { startCreativeSession, ProductNotFoundError as CreativeStudioProductNotFoundError } from "../../services/creative-studio/session.server";

const KIND_LABEL: Record<AssetKind, string> = {
  GENERATION: "Product generation",
  PROCESSING: "Product processing",
  STORE_VISUAL: "Store visual",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Not reviewed",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

const STATUS_TONE: Record<string, "info" | "success" | "critical"> = {
  PENDING: "info",
  APPROVED: "success",
  REJECTED: "critical",
};

// Human-readable labels for every subtype this page might show — spans
// all three domains' enums (GenerationType/ImageOperation/StoreVisualType).
// A value with no entry here just falls back to itself (see `subtypeLabel`)
// rather than needing this kept in perfect lockstep with every enum.
const SUBTYPE_LABEL: Record<string, string> = {
  PRODUCT_CLEANUP: "Product cleanup",
  BACKGROUND_REMOVAL: "Background removal",
  BACKGROUND_REPLACEMENT: "Background replacement",
  LIFESTYLE: "Lifestyle scene",
  MODEL_SHOOT: "Model photography",
  BANNER: "Promotional banner",
  CATEGORY_BANNER: "Category banner",
  CTA: "Call-to-action image",
  CAMPAIGN: "Campaign asset",
  REMOVE_BACKGROUND: "Remove background",
  ENHANCE: "Enhance",
  UPSCALE: "Upscale",
  GENERATE_SHADOW: "Generate shadow",
  RESIZE: "Resize",
  CROP: "Crop",
  HOMEPAGE_HERO: "Homepage hero",
  COLLECTION_BANNER: "Collection banner",
  STORE_CTA: "Store call-to-action",
  CREATIVE_STUDIO: "Creative Studio",
};

// AssetItem.kind → the Creative Studio's CreativeSourceType for that
// result — STORE_VISUAL is deliberately absent (this merged view never
// carries a per-item productId for a store visual — see
// services/assets/types.ts's AssetItem.productId doc comment — so
// "Open in Creative Studio" isn't offered for those rows).
const CREATIVE_SOURCE_TYPE_BY_KIND: Partial<Record<AssetKind, "GENERATION_RESULT" | "PROCESSING_RESULT">> = {
  GENERATION: "GENERATION_RESULT",
  PROCESSING: "PROCESSING_RESULT",
};

function subtypeLabel(subtype: string): string {
  return SUBTYPE_LABEL[subtype] ?? subtype;
}

function detailHref(item: AssetItem): string {
  if (item.kind === "STORE_VISUAL") return `/app/store-visuals/${item.jobId}`;
  return `/app/products/${item.productId}`;
}

const NOT_FOUND_RESPONSE = () => new Response("Product not found", { status: 404 });
const GENERIC_ERROR = "Couldn't open the Creative Studio right now. Please try again.";

// The one exception to this page's normal "read-only, links out to each
// domain's own detail page" design (see module doc comment) — starting a
// Creative Studio session creates a real row, which can't be a plain GET
// link, but Part 13 explicitly asks for "AI Assets → Open in Creative
// Studio" as a direct entry point.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "start-creative-session") {
    const productId = formData.get("productId");
    const sourceType = formData.get("sourceType");
    const sourceResultId = formData.get("sourceResultId");
    if (
      typeof productId !== "string" ||
      typeof sourceResultId !== "string" ||
      (sourceType !== "GENERATION_RESULT" && sourceType !== "PROCESSING_RESULT")
    ) {
      return { ok: false as const, error: GENERIC_ERROR };
    }
    try {
      const session = await startCreativeSession(context, { productId, sourceType, sourceResultId });
      return redirect(`/app/creative/${session.id}`);
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof CreativeStudioProductNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: GENERIC_ERROR };
    }
  }

  return { ok: false as const, error: "Unknown action." };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");
  const statusParam = url.searchParams.get("status");
  const page = Number(url.searchParams.get("page")) || 1;

  const kind = ASSET_KINDS.includes(kindParam as AssetKind) ? (kindParam as AssetKind) : undefined;
  const status = statusParam === "PENDING" || statusParam === "APPROVED" || statusParam === "REJECTED" ? statusParam : undefined;

  const result = await listAssetLibrary(context, { kind, status }, page);
  return { result, kind: kind ?? "", status: status ?? "" };
};

export default function AssetLibrary() {
  const { result, kind, status } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const creativeStudioFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (creativeStudioFetcher.data && !creativeStudioFetcher.data.ok) {
      shopify.toast.show(creativeStudioFetcher.data.error, { isError: true });
    }
  }, [creativeStudioFetcher.data, shopify]);

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize));

  const updateFilter = (key: "kind" | "status", value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setSearchParams(next);
  };

  const goToPage = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    setSearchParams(next);
  };

  return (
    <s-page heading="AI Assets">
      <s-link slot="breadcrumb-actions" href="/app/store-visuals">
        Create a store visual
      </s-link>

      <s-section heading="Everything this shop has generated">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Every AI-generated or processed image across product imagery and store visuals, newest first.
          </s-text>

          <s-stack direction="inline" gap="base">
            <s-select
              label="Source"
              labelAccessibilityVisibility="visible"
              value={kind}
              onChange={(event: Event) => updateFilter("kind", (event.currentTarget as HTMLSelectElement).value)}
            >
              <s-option value="">All sources</s-option>
              {ASSET_KINDS.map((k) => (
                <s-option key={k} value={k}>
                  {KIND_LABEL[k]}
                </s-option>
              ))}
            </s-select>

            <s-select
              label="Status"
              labelAccessibilityVisibility="visible"
              value={status}
              onChange={(event: Event) => updateFilter("status", (event.currentTarget as HTMLSelectElement).value)}
            >
              <s-option value="">Any status</s-option>
              <s-option value="PENDING">Not reviewed</s-option>
              <s-option value="APPROVED">Approved</s-option>
              <s-option value="REJECTED">Rejected</s-option>
            </s-select>
          </s-stack>

          {result.items.length === 0 ? (
            <s-paragraph color="subdued">
              Nothing here yet. Generate product imagery from a product&rsquo;s detail page, or{" "}
              <s-link href="/app/store-visuals">create a store visual</s-link>.
            </s-paragraph>
          ) : (
            <s-table
              paginate
              hasNextPage={result.page < totalPages}
              hasPreviousPage={result.page > 1}
              onNextPage={() => goToPage(result.page + 1)}
              onPreviousPage={() => goToPage(result.page - 1)}
            >
              <s-table-header-row>
                <s-table-header listSlot="inline">Preview</s-table-header>
                <s-table-header listSlot="primary">Type</s-table-header>
                <s-table-header listSlot="secondary">Source</s-table-header>
                <s-table-header listSlot="secondary">Status</s-table-header>
                <s-table-header listSlot="secondary">Created</s-table-header>
                <s-table-header listSlot="secondary">Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {result.items.map((item) => {
                  const creativeSourceType = CREATIVE_SOURCE_TYPE_BY_KIND[item.kind];
                  return (
                    <s-table-row key={item.id}>
                      <s-table-cell>
                        {item.url ? (
                          <s-thumbnail src={item.url} alt={subtypeLabel(item.subtype)} size="small" />
                        ) : (
                          <s-text color="subdued">—</s-text>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <s-link href={detailHref(item)}>{subtypeLabel(item.subtype)}</s-link>
                        {item.productTitle && <s-text color="subdued"> · {item.productTitle}</s-text>}
                      </s-table-cell>
                      <s-table-cell>{KIND_LABEL[item.kind]}</s-table-cell>
                      <s-table-cell>
                        <s-badge tone={STATUS_TONE[item.reviewStatus]}>{STATUS_LABEL[item.reviewStatus]}</s-badge>
                      </s-table-cell>
                      <s-table-cell>{new Date(item.createdAt).toLocaleDateString()}</s-table-cell>
                      <s-table-cell>
                        {creativeSourceType && item.productId && (
                          <s-button
                            variant="tertiary"
                            onClick={() =>
                              creativeStudioFetcher.submit(
                                { intent: "start-creative-session", productId: item.productId!, sourceType: creativeSourceType, sourceResultId: item.id },
                                { method: "POST" },
                              )
                            }
                          >
                            Open in Creative Studio
                          </s-button>
                        )}
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
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
