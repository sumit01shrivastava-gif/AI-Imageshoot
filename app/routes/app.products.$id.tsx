import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { fetchProductVariants, type ProductVariant } from "../../services/products/shopify-queries.server";
import { logger } from "../../lib/logging/logger.server";
import { TenantMismatchError } from "../../lib/auth";
import {
  requestProductAnalysis,
  getProductIntelligence,
  getIntelligenceDisplayState,
  ProductNotFoundError,
  type IntelligenceDisplayState,
} from "../../services/intelligence/product-intelligence.server";
import { useSelection } from "../components/selection-context";
import { SelectionBar } from "../components/selection-bar";

const NOT_FOUND_RESPONSE = () => new Response("Product not found", { status: 404 });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, context } = await requireAdminContext(request);

  let product: Awaited<ReturnType<typeof findProductForShop>>;
  try {
    product = await findProductForShop(context, params.id!);
  } catch (error) {
    if (error instanceof TenantMismatchError) {
      // A real product id, just not one belonging to this shop — e.g. a
      // merchant editing the URL to probe another tenant's data. Respond
      // exactly like "doesn't exist" (same status, same generic message)
      // so this is never distinguishable from a not-found id — see the
      // Phase 0/1 security audit ("existence oracle" finding). The
      // specific detail (which shop attempted this, which id) stays
      // server-side only, in this log line.
      logger.warn("products.detail.tenant_mismatch", {
        shop: context.shop,
        requestedId: params.id,
      });
      throw NOT_FOUND_RESPONSE();
    }
    throw error;
  }

  if (!product) {
    throw NOT_FOUND_RESPONSE();
  }

  let variants: { count: number; variants: ProductVariant[] } | null = null;
  let variantsError: string | null = null;
  try {
    variants = await fetchProductVariants(admin, product.shopifyProductId);
  } catch (error) {
    // Variants are a nice-to-have on this page — don't fail the whole
    // product view if Shopify is briefly unreachable/rate-limited. See
    // CLAUDE.md "Error handling".
    variantsError = "Couldn't load variant details from Shopify right now.";
    logger.warn("products.detail.variants_fetch_failed", {
      shop: context.shop,
      productId: product.id,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }

  const intelligence = await getProductIntelligence(context, product.id);
  const intelligenceState = getIntelligenceDisplayState(intelligence, product);

  return { product, variants, variantsError, intelligence, intelligenceState };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "analyze") {
    try {
      await requestProductAnalysis(context, params.id!);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof ProductNotFoundError) {
        // Same "indistinguishable from not-found" handling as the loader —
        // see its comment above.
        logger.warn("products.detail.analyze_tenant_mismatch_or_missing", {
          shop: context.shop,
          requestedId: params.id,
        });
        throw NOT_FOUND_RESPONSE();
      }
      logger.error("products.detail.analyze_request_failed", {
        shop: context.shop,
        productId: params.id,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return { ok: false as const, error: "Couldn't start analysis right now. Please try again." };
    }
  }

  return { ok: false as const, error: "Unknown action." };
};

const INTELLIGENCE_STATE_LABEL: Record<IntelligenceDisplayState, string> = {
  not_analyzed: "Not analyzed",
  analyzing: "Analyzing",
  ready: "Ready",
  stale: "Stale",
  failed: "Failed",
};

const INTELLIGENCE_STATE_TONE: Record<IntelligenceDisplayState, "info" | "success" | "warning" | "critical"> = {
  not_analyzed: "info",
  analyzing: "info",
  ready: "success",
  stale: "warning",
  failed: "critical",
};

export default function ProductDetail() {
  const { product, variants, variantsError, intelligence, intelligenceState } =
    useLoaderData<typeof loader>();
  const { isImageSelected, toggleImage, setProductImages, productSelectionState, selectedCountForProduct } =
    useSelection();
  const analyzeFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const selectableProduct = { id: product.id, title: product.title, handle: product.handle };
  const imageIds = product.media.map((media) => media.id);
  const selectableImages = product.media.map((media) => ({
    id: media.id,
    url: media.previewUrl ?? media.originalUrl,
    altText: media.altText,
  }));
  const state = productSelectionState(product.id, imageIds);
  const selectedCount = selectedCountForProduct(product.id);

  // Tracks "a request to analyze this product is outstanding" from the
  // moment the button is clicked until the profile lands in a terminal
  // state (ready/stale/failed). This — not `intelligenceState ===
  // "analyzing"` alone — is what the poll below keys off: the *first*
  // state observed right after the action (via React Router's automatic
  // post-action revalidation) is typically still "not_analyzed" (the row
  // is PENDING — the worker hasn't called `markProcessing` yet), so
  // polling only while "analyzing" would arm too late and never catch up.
  const [awaitingResult, setAwaitingResult] = useState(false);
  const isAnalyzing = awaitingResult || intelligenceState === "analyzing";

  // Reset `awaitingResult` once the request reaches a terminal state.
  // This uses React's render-phase "adjusting state when a value changes"
  // pattern (compare against a previous-value snapshot, setState directly
  // during render) rather than an effect, because the value is already
  // known synchronously during render — a `useEffect` here would just add
  // an extra render-then-effect-then-render cascade for no benefit. See
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevIntelligenceState, setPrevIntelligenceState] = useState(intelligenceState);
  if (intelligenceState !== prevIntelligenceState) {
    setPrevIntelligenceState(intelligenceState);
    if (intelligenceState === "ready" || intelligenceState === "stale" || intelligenceState === "failed") {
      setAwaitingResult(false);
    }
  }

  const [prevFetcherData, setPrevFetcherData] = useState(analyzeFetcher.data);
  if (analyzeFetcher.data !== prevFetcherData) {
    setPrevFetcherData(analyzeFetcher.data);
    if (analyzeFetcher.data && !analyzeFetcher.data.ok) {
      setAwaitingResult(false);
    }
  }

  // Auto-refresh while a requested analysis hasn't landed yet, so the
  // state moves to "Ready"/"Failed" on its own — same pattern as the
  // Products page's sync-in-progress polling.
  useEffect(() => {
    if (!awaitingResult) return;
    if (intelligenceState !== "not_analyzed" && intelligenceState !== "analyzing") return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [awaitingResult, intelligenceState, revalidator]);

  useEffect(() => {
    if (analyzeFetcher.data?.ok) {
      shopify.toast.show("Analysis started");
    } else if (analyzeFetcher.data && !analyzeFetcher.data.ok) {
      shopify.toast.show(analyzeFetcher.data.error, { isError: true });
    }
  }, [analyzeFetcher.data, shopify]);

  const requestAnalysis = () => {
    setAwaitingResult(true);
    analyzeFetcher.submit({ intent: "analyze" }, { method: "POST" });
  };

  return (
    <s-page heading={product.title}>
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>
      <s-section>
        <s-stack direction="block" gap="base">
          <SelectionBar />

          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-heading>Images ({product.media.length})</s-heading>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="tertiary"
                onClick={() => setProductImages(selectableProduct, selectableImages)}
                disabled={state === "all" || imageIds.length === 0}
              >
                Select all images
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => setProductImages(selectableProduct, [])}
                disabled={selectedCount === 0}
              >
                Clear this product
              </s-button>
            </s-stack>
          </s-stack>

          {product.media.length === 0 ? (
            <s-paragraph>No images found for this product.</s-paragraph>
          ) : (
            <s-grid gridTemplateColumns="repeat(auto-fill, minmax(140px, 1fr))" gap="base">
              {product.media.map((media) => {
                const selected = isImageSelected(product.id, media.id);
                const selectableImage = {
                  id: media.id,
                  url: media.previewUrl ?? media.originalUrl,
                  altText: media.altText,
                };
                return (
                  // Toggling lives on the outer s-clickable only. The
                  // checkbox is a controlled visual indicator (no onChange
                  // of its own) — a click or keyboard activation on it
                  // bubbles up as a click on s-clickable, so wiring both
                  // would double-toggle (select, then immediately
                  // deselect) since the checkbox's own click also bubbles.
                  <s-clickable
                    key={media.id}
                    onClick={() => toggleImage(selectableProduct, selectableImage)}
                  >
                    <s-box
                      padding="small-200"
                      borderWidth={selected ? "large" : "base"}
                      borderRadius="base"
                      borderColor={selected ? "strong" : "subdued"}
                    >
                      <s-stack direction="block" gap="small-200">
                        <s-image
                          src={media.previewUrl ?? media.originalUrl}
                          alt={media.altText ?? product.title}
                        />
                        <s-checkbox
                          accessibilityLabel={`Select image ${media.altText ?? ""}`.trim()}
                          checked={selected}
                        />
                      </s-stack>
                    </s-box>
                  </s-clickable>
                );
              })}
            </s-grid>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Product Intelligence">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            <s-badge tone={INTELLIGENCE_STATE_TONE[intelligenceState]}>
              {INTELLIGENCE_STATE_LABEL[intelligenceState]}
            </s-badge>
            <s-button
              variant={intelligenceState === "ready" || intelligenceState === "stale" ? "tertiary" : "primary"}
              onClick={requestAnalysis}
              disabled={isAnalyzing}
              {...(isAnalyzing ? { loading: true } : {})}
            >
              {intelligenceState === "ready" || intelligenceState === "stale"
                ? "Re-analyze Product"
                : "Analyze Product"}
            </s-button>
          </s-stack>

          {intelligenceState === "stale" && (
            <s-banner tone="warning">
              <s-paragraph>
                This product changed in Shopify since it was last analyzed. Re-analyze to refresh
                the intelligence below.
              </s-paragraph>
            </s-banner>
          )}

          {intelligenceState === "failed" && (
            <s-banner tone="critical">
              <s-paragraph>{intelligence?.errorMessage ?? "Analysis failed."}</s-paragraph>
            </s-banner>
          )}

          {intelligenceState === "not_analyzed" && (
            <s-paragraph color="subdued">
              Not analyzed yet. Click &ldquo;Analyze Product&rdquo; to build a structured profile
              (category, material, style, and generation recommendations) from this
              product&rsquo;s Shopify data and images.
            </s-paragraph>
          )}

          {(intelligenceState === "ready" || intelligenceState === "stale") && intelligence && (
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))" gap="base">
              <IntelligenceField label="Category" value={intelligence.category} />
              <IntelligenceField label="Subcategory" value={intelligence.subcategory} />
              <IntelligenceField label="Material" value={intelligence.material} />
              <IntelligenceField
                label="Color"
                value={[intelligence.primaryColor, ...intelligence.secondaryColors]
                  .filter(Boolean)
                  .join(", ")}
              />
              <IntelligenceField label="Style" value={intelligence.style} />
              <IntelligenceField
                label="Use cases"
                value={intelligence.useCases.length > 0 ? intelligence.useCases.join(", ") : null}
              />
              <IntelligenceField
                label="Model suitable"
                value={intelligence.modelSuitable === null ? null : intelligence.modelSuitable ? "Yes" : "No"}
              />
              <IntelligenceField
                label="Recommended asset types"
                value={
                  intelligence.recommendedAssetTypes.length > 0
                    ? intelligence.recommendedAssetTypes.join(", ")
                    : null
                }
              />
            </s-grid>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Details">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            <s-text type="strong">Type: </s-text>
            <s-text>{product.productType || "—"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Category: </s-text>
            <s-text>{product.category || "—"}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">Vendor: </s-text>
            <s-text>{product.vendor || "—"}</s-text>
          </s-paragraph>
          {product.tags.length > 0 && (
            <s-paragraph>
              <s-text type="strong">Tags: </s-text>
              <s-text>{product.tags.join(", ")}</s-text>
            </s-paragraph>
          )}
          {product.description && (
            <s-paragraph>
              <s-text type="strong">Description</s-text>
            </s-paragraph>
          )}
          {product.description && <s-paragraph>{product.description}</s-paragraph>}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Variants">
        {variantsError && <s-paragraph color="subdued">{variantsError}</s-paragraph>}
        {!variantsError && variants && variants.variants.length > 0 && (
          <s-stack direction="block" gap="small-200">
            {variants.variants.map((variant) => (
              <s-paragraph key={variant.id}>
                {variant.title} — {variant.price}
                {!variant.availableForSale && (
                  <>
                    {" "}
                    <s-badge tone="warning">Unavailable</s-badge>
                  </>
                )}
              </s-paragraph>
            ))}
            {variants.count > variants.variants.length && (
              <s-text color="subdued">
                Showing {variants.variants.length} of {variants.count} variants.
              </s-text>
            )}
          </s-stack>
        )}
        {!variantsError && (!variants || variants.variants.length === 0) && (
          <s-paragraph color="subdued">No variants.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

function IntelligenceField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value || "—"}</s-text>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
