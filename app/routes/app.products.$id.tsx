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
import {
  requestGeneration,
  listGenerationHistory,
  ProductNotFoundError as GenerationProductNotFoundError,
  MissingSourceImagesError,
  ProductNotAnalyzedError,
  InvalidGenerationRequestError,
} from "../../services/generation/request-generation.server";
import type { GenerationResultRow } from "../../db/repositories/generation-job.repository";
import {
  requestProcessing,
  createAndEnqueueProcessingJob,
  reviewProcessingResult,
  getProcessing,
  listProcessingHistory,
  ProductNotFoundError as ProcessingProductNotFoundError,
  SourceImageNotFoundError,
  InvalidProcessingRequestError,
  ProcessingResultNotFoundError,
} from "../../services/processing/request-processing.server";
import { parseProcessingOptions } from "../../services/processing/schema";
import { IMPLEMENTED_OPERATIONS, type ImageOperationValue } from "../../services/processing/types";
import type { ProcessingJobRow, ProcessingResultRow } from "../../db/repositories/processing-job.repository";
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

  // Most-recent-first — see docs/generation.md "Generation history". The
  // UI only ever renders the latest as "current" plus a compact list of
  // the rest; nothing here fetches results eagerly beyond what the
  // repository's select already includes.
  const generationHistory = await listGenerationHistory(context, product.id);

  // Most-recent-first — see docs/image-processing.md "Versioning". Same
  // reasoning as generationHistory above: every request is its own
  // preserved row, never overwritten.
  const processingHistory = await listProcessingHistory(context, product.id);

  return {
    product,
    variants,
    variantsError,
    intelligence,
    intelligenceState,
    generationHistory,
    processingHistory,
  };
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

  if (intent === "generate") {
    try {
      // "Generate Test Image" (docs/generation.md "UI") — no image picker,
      // no generation-type selector: PRODUCT_CLEANUP against every one of
      // the product's current media (see request-generation.server.ts's
      // `sourceMediaIds` default). Proving the architecture, not the full
      // studio UI — see the Phase 3 instructions.
      await requestGeneration(context, { productId: params.id!, generationType: "PRODUCT_CLEANUP" });
      return { ok: true as const };
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof GenerationProductNotFoundError) {
        // Same "indistinguishable from not-found" handling as the loader —
        // see its comment above.
        logger.warn("products.detail.generate_tenant_mismatch_or_missing", {
          shop: context.shop,
          requestedId: params.id,
        });
        throw NOT_FOUND_RESPONSE();
      }
      if (error instanceof ProductNotAnalyzedError) {
        return { ok: false as const, error: error.message };
      }
      if (error instanceof MissingSourceImagesError || error instanceof InvalidGenerationRequestError) {
        return { ok: false as const, error: error.message };
      }
      logger.error("products.detail.generate_request_failed", {
        shop: context.shop,
        productId: params.id,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return { ok: false as const, error: "Couldn't start generation right now. Please try again." };
    }
  }

  if (intent === "process") {
    const sourceMediaId = formData.get("sourceMediaId");
    const operation = formData.get("operation");
    if (typeof sourceMediaId !== "string" || typeof operation !== "string") {
      return { ok: false as const, error: "Couldn't start processing right now. Please try again." };
    }
    try {
      await requestProcessing(context, { productId: params.id!, sourceMediaId, operation });
      return { ok: true as const };
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof ProcessingProductNotFoundError) {
        // Same "indistinguishable from not-found" handling as the loader —
        // see its comment above.
        logger.warn("products.detail.process_tenant_mismatch_or_missing", {
          shop: context.shop,
          requestedId: params.id,
        });
        throw NOT_FOUND_RESPONSE();
      }
      if (error instanceof SourceImageNotFoundError || error instanceof InvalidProcessingRequestError) {
        return { ok: false as const, error: error.message };
      }
      logger.error("products.detail.process_request_failed", {
        shop: context.shop,
        productId: params.id,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return { ok: false as const, error: "Couldn't start processing right now. Please try again." };
    }
  }

  if (intent === "review-processing-result") {
    const resultId = formData.get("resultId");
    const decision = formData.get("decision");
    if (typeof resultId !== "string" || (decision !== "APPROVED" && decision !== "REJECTED")) {
      return { ok: false as const, error: "Couldn't complete that action right now. Please try again." };
    }
    try {
      await reviewProcessingResult(context, resultId, decision);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof ProcessingResultNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: "Couldn't complete that action right now. Please try again." };
    }
  }

  if (intent === "regenerate-processing") {
    const jobId = formData.get("jobId");
    if (typeof jobId !== "string") {
      return { ok: false as const, error: "Couldn't start processing right now. Please try again." };
    }
    try {
      // Looked up server-side (never trusting a client-supplied
      // product/media/operation) — mirrors
      // app/routes/app.processing.$batchId.tsx's "regenerate" action: the
      // new request always mirrors the EXACT product/source image/
      // operation/options the original job used, and carries the same
      // batchId forward if the original was part of one.
      const original = await getProcessing(context, jobId);
      if (!original) throw NOT_FOUND_RESPONSE();

      await createAndEnqueueProcessingJob(context, {
        productId: original.productId,
        sourceMediaId: original.sourceMediaId,
        operation: original.operation,
        options: parseProcessingOptions(original.options),
        batchId: original.batchId ?? undefined,
      });
      return { ok: true as const };
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof ProcessingProductNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: "Couldn't start processing right now. Please try again." };
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

// PENDING/QUEUED share one label — see build-plan.ts's model comment for
// why PENDING is a real but typically-instantaneous state (immediately
// followed by QUEUED within the same request) that a merchant is unlikely
// to ever actually observe.
const GENERATION_STATUS_LABEL: Record<string, string> = {
  PENDING: "Queued",
  QUEUED: "Queued",
  PROCESSING: "Processing",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const GENERATION_STATUS_TONE: Record<string, "info" | "success" | "warning" | "critical"> = {
  PENDING: "info",
  QUEUED: "info",
  PROCESSING: "info",
  SUCCEEDED: "success",
  FAILED: "critical",
  CANCELLED: "warning",
};

// Same shape/values as GENERATION_STATUS_LABEL/_TONE — ProcessingStatus is
// its own Prisma enum (see prisma/schema.prisma's model comment) but
// happens to share the same five-terminal-plus-in-flight vocabulary.
const PROCESSING_STATUS_LABEL = GENERATION_STATUS_LABEL;
const PROCESSING_STATUS_TONE = GENERATION_STATUS_TONE;

const OPERATION_LABEL: Record<ImageOperationValue, string> = {
  REMOVE_BACKGROUND: "Remove background",
  ENHANCE: "Enhance",
  UPSCALE: "Upscale",
  GENERATE_SHADOW: "Add shadow",
  RESIZE: "Resize",
  CROP: "Crop",
};

export default function ProductDetail() {
  const {
    product,
    variants,
    variantsError,
    intelligence,
    intelligenceState,
    generationHistory,
    processingHistory,
  } = useLoaderData<typeof loader>();
  const { isImageSelected, toggleImage, setProductImages, productSelectionState, selectedCountForProduct } =
    useSelection();
  const analyzeFetcher = useFetcher<typeof action>();
  const generateFetcher = useFetcher<typeof action>();
  const processFetcher = useFetcher<typeof action>();
  const processingReviewFetcher = useFetcher<typeof action>();
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

  // --- Image Generation (Phase 3) ---------------------------------------
  // Each "Generate"/"Regenerate" click creates a brand-new GenerationJob
  // row (see docs/generation.md "Generation history") — so, unlike
  // Product Intelligence's single upserted row, `generationHistory[0]`
  // (most-recent-first) is unambiguously the request this click just
  // made, the moment the post-action revalidation lands. No "which state
  // means 'not started yet' vs. 'a fresh request that hasn't been picked
  // up'" ambiguity to work around here.
  const latestGeneration = generationHistory[0] ?? null;
  const generationStatus = latestGeneration?.status;
  const isTerminalGenerationStatus =
    generationStatus === "SUCCEEDED" || generationStatus === "FAILED" || generationStatus === "CANCELLED";

  const [awaitingGeneration, setAwaitingGeneration] = useState(false);
  const isGenerating = awaitingGeneration || (generationStatus !== undefined && !isTerminalGenerationStatus);

  const [prevGenerationStatus, setPrevGenerationStatus] = useState(generationStatus);
  if (generationStatus !== prevGenerationStatus) {
    setPrevGenerationStatus(generationStatus);
    if (isTerminalGenerationStatus) {
      setAwaitingGeneration(false);
    }
  }

  const [prevGenerateFetcherData, setPrevGenerateFetcherData] = useState(generateFetcher.data);
  if (generateFetcher.data !== prevGenerateFetcherData) {
    setPrevGenerateFetcherData(generateFetcher.data);
    if (generateFetcher.data && !generateFetcher.data.ok) {
      setAwaitingGeneration(false);
    }
  }

  useEffect(() => {
    if (!awaitingGeneration || isTerminalGenerationStatus) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [awaitingGeneration, isTerminalGenerationStatus, revalidator]);

  useEffect(() => {
    if (generateFetcher.data?.ok) {
      shopify.toast.show("Generation started");
    } else if (generateFetcher.data && !generateFetcher.data.ok) {
      shopify.toast.show(generateFetcher.data.error, { isError: true });
    }
  }, [generateFetcher.data, shopify]);

  const canGenerate = intelligenceState === "ready" || intelligenceState === "stale";
  const requestGenerationClick = () => {
    setAwaitingGeneration(true);
    generateFetcher.submit({ intent: "generate" }, { method: "POST" });
  };

  // --- Image Processing (Phase 4) ----------------------------------------
  // Same "each action creates a brand-new, independently-preserved row"
  // shape as generation above — `processingHistory[0]` (most-recent-first)
  // is unambiguously whichever per-image action was just started,
  // regardless of which of the product's images it targeted. Only
  // POLL — never for an already-terminal job (see the Phase 4
  // instructions) — while a just-started request hasn't landed yet.
  const latestProcessing = processingHistory[0] ?? null;
  const processingStatus = latestProcessing?.status;
  const isTerminalProcessingStatus =
    processingStatus === "SUCCEEDED" || processingStatus === "FAILED" || processingStatus === "CANCELLED";

  const [awaitingProcessing, setAwaitingProcessing] = useState(false);
  const isProcessing = awaitingProcessing || (processingStatus !== undefined && !isTerminalProcessingStatus);

  const [prevProcessingStatus, setPrevProcessingStatus] = useState(processingStatus);
  if (processingStatus !== prevProcessingStatus) {
    setPrevProcessingStatus(processingStatus);
    if (isTerminalProcessingStatus) {
      setAwaitingProcessing(false);
    }
  }

  const [prevProcessFetcherData, setPrevProcessFetcherData] = useState(processFetcher.data);
  if (processFetcher.data !== prevProcessFetcherData) {
    setPrevProcessFetcherData(processFetcher.data);
    if (processFetcher.data && !processFetcher.data.ok) {
      setAwaitingProcessing(false);
    }
  }

  useEffect(() => {
    if (!awaitingProcessing || isTerminalProcessingStatus) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [awaitingProcessing, isTerminalProcessingStatus, revalidator]);

  useEffect(() => {
    if (processFetcher.data?.ok) {
      shopify.toast.show("Processing started");
    } else if (processFetcher.data && !processFetcher.data.ok) {
      shopify.toast.show(processFetcher.data.error, { isError: true });
    }
  }, [processFetcher.data, shopify]);

  useEffect(() => {
    if (processingReviewFetcher.data && !processingReviewFetcher.data.ok) {
      shopify.toast.show(processingReviewFetcher.data.error, { isError: true });
    }
  }, [processingReviewFetcher.data, shopify]);

  const requestProcessingAction = (sourceMediaId: string, operation: ImageOperationValue) => {
    setAwaitingProcessing(true);
    processFetcher.submit({ intent: "process", sourceMediaId, operation }, { method: "POST" });
  };

  const regenerateProcessing = (jobId: string) => {
    setAwaitingProcessing(true);
    processFetcher.submit({ intent: "regenerate-processing", jobId }, { method: "POST" });
  };

  const reviewProcessing = (resultId: string, decision: "APPROVED" | "REJECTED") => {
    processingReviewFetcher.submit({ intent: "review-processing-result", resultId, decision }, { method: "POST" });
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

      <s-section heading="Image Generation">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            {generationStatus ? (
              <s-badge tone={GENERATION_STATUS_TONE[generationStatus]}>
                {GENERATION_STATUS_LABEL[generationStatus]}
              </s-badge>
            ) : (
              <s-badge tone="info">Not generated yet</s-badge>
            )}
            <s-button
              variant={latestGeneration ? "tertiary" : "primary"}
              onClick={requestGenerationClick}
              disabled={isGenerating || !canGenerate}
              {...(isGenerating ? { loading: true } : {})}
            >
              {latestGeneration ? "Regenerate" : "Generate Test Image"}
            </s-button>
          </s-stack>

          {!canGenerate && (
            <s-paragraph color="subdued">
              Analyze this product (see Product Intelligence above) before generating images —
              generation needs its identity anchors to preserve the product&rsquo;s real category,
              material, and color.
            </s-paragraph>
          )}

          {generationStatus === "FAILED" && (
            <s-banner tone="critical">
              <s-paragraph>{latestGeneration?.errorMessage ?? "Generation failed."}</s-paragraph>
            </s-banner>
          )}

          {!latestGeneration && canGenerate && (
            <s-paragraph color="subdued">
              No test generation yet. This uses the safe, deterministic development provider — see
              docs/generation.md — to prove the request → job → provider → storage → result
              pipeline end to end. No real AI image is produced.
            </s-paragraph>
          )}

          {generationStatus === "SUCCEEDED" && latestGeneration && (
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
              {latestGeneration.results.map((result, index) => (
                <GenerationResultCard key={result.id} result={result} index={index} />
              ))}
            </s-grid>
          )}

          {generationHistory.length > 1 && (
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Generation history</s-text>
              <s-stack direction="block" gap="small-200">
                {generationHistory.map((job, index) => (
                  <s-paragraph key={job.id}>
                    Generation #{generationHistory.length - index} —{" "}
                    <s-badge tone={GENERATION_STATUS_TONE[job.status]}>
                      {GENERATION_STATUS_LABEL[job.status]}
                    </s-badge>{" "}
                    <s-text color="subdued">{new Date(job.createdAt).toLocaleString()}</s-text>
                  </s-paragraph>
                ))}
              </s-stack>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Image Processing">
        <s-stack direction="block" gap="large">
          {product.media.length === 0 ? (
            <s-paragraph color="subdued">No images to process — this product has no Shopify images.</s-paragraph>
          ) : (
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                Source images — background removal, enhancement, and resizing never modify the
                original Shopify image; each run creates a new, separately reviewable result.
              </s-text>
              <s-grid gridTemplateColumns="repeat(auto-fill, minmax(160px, 1fr))" gap="base">
                {product.media.map((media) => (
                  <s-box key={media.id} padding="small-200" borderWidth="base" borderRadius="base" borderColor="subdued">
                    <s-stack direction="block" gap="small-200">
                      <s-image src={media.previewUrl ?? media.originalUrl} alt={media.altText ?? product.title} />
                      <s-text color="subdued">Original</s-text>
                      <s-stack direction="block" gap="small-100">
                        {IMPLEMENTED_OPERATIONS.map((operation) => (
                          <s-button
                            key={operation}
                            variant="tertiary"
                            disabled={isProcessing}
                            onClick={() => requestProcessingAction(media.id, operation)}
                          >
                            {OPERATION_LABEL[operation]}
                          </s-button>
                        ))}
                      </s-stack>
                    </s-stack>
                  </s-box>
                ))}
              </s-grid>
            </s-stack>
          )}

          {isProcessing && (
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-badge tone="info">
                {latestProcessing ? PROCESSING_STATUS_LABEL[latestProcessing.status] : "Queued"}
              </s-badge>
              <s-text color="subdued">Processing your most recent request…</s-text>
            </s-stack>
          )}

          {processingStatus === "FAILED" && !isProcessing && (
            <s-banner tone="critical">
              <s-paragraph>{latestProcessing?.errorMessage ?? "Processing failed."}</s-paragraph>
            </s-banner>
          )}

          {latestProcessing && processingStatus === "SUCCEEDED" && (
            <s-stack direction="block" gap="base">
              <s-heading>Latest result</s-heading>
              <ProcessingResultDetail
                job={latestProcessing}
                onReview={reviewProcessing}
                onRegenerate={() => regenerateProcessing(latestProcessing.id)}
                isRegenerating={isProcessing}
              />
            </s-stack>
          )}

          {processingHistory.length > 0 && (
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Processing history</s-text>
              <s-stack direction="block" gap="small-200">
                {processingHistory.map((job, index) => {
                  const result = job.results[job.results.length - 1];
                  return (
                    <s-paragraph key={job.id}>
                      Process #{processingHistory.length - index} — {OPERATION_LABEL[job.operation]}{" "}
                      <s-badge tone={PROCESSING_STATUS_TONE[job.status]}>
                        {PROCESSING_STATUS_LABEL[job.status]}
                      </s-badge>{" "}
                      {result && (
                        <>
                          {result.width && result.height ? `${result.width}×${result.height} · ` : ""}
                          {result.reviewStatus === "APPROVED"
                            ? "Approved"
                            : result.reviewStatus === "REJECTED"
                              ? "Rejected"
                              : "Not reviewed"}{" "}
                        </>
                      )}
                      <s-text color="subdued">{new Date(job.createdAt).toLocaleString()}</s-text>
                    </s-paragraph>
                  );
                })}
              </s-stack>
            </s-stack>
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

/**
 * `result.url` is a signed `/media/<key>?expires=...&sig=...` reference
 * (lib/storage/local-filesystem-provider.server.ts, served by
 * app/routes/media.$.tsx) as of Phase 4's storage change — a real,
 * fetchable image, not a filesystem path. The deterministic test provider
 * (this phase's only wired-up `ImageGenerationProvider`) still produces a
 * placeholder 1x1 pixel, so what renders here in tests/dev is that
 * placeholder — but the plumbing (storage → signed URL → `<s-image>`) is
 * the real, production path. See docs/generation.md "Storage" and
 * docs/image-processing.md "Signed media URL architecture".
 */
function GenerationResultCard({ result, index }: { result: GenerationResultRow; index: number }) {
  return (
    <s-box padding="small-200" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">Result {index + 1}</s-text>
        {result.url && <s-image src={result.url} alt={`Generated result ${index + 1}`} />}
        <s-text color="subdued">
          {result.format ?? "—"}
          {result.width && result.height ? ` · ${result.width}×${result.height}` : ""}
        </s-text>
        <s-text color="subdued">{result.providerName ?? "—"}</s-text>
      </s-stack>
    </s-box>
  );
}

/**
 * The detailed "latest result" card for Image Processing — original
 * (Shopify's own CDN URL, never modified) vs. processed (a signed
 * `/media/<key>` reference — see GenerationResultCard's doc comment
 * above for why this is a real, fetchable URL, not a filesystem path),
 * operation, dimensions, status, created time, and Approve/Reject/
 * Regenerate. See docs/image-processing.md "Result review UI".
 */
function ProcessingResultDetail({
  job,
  onReview,
  onRegenerate,
  isRegenerating,
}: {
  job: ProcessingJobRow;
  onReview: (resultId: string, decision: "APPROVED" | "REJECTED") => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
}) {
  const result: ProcessingResultRow | undefined = job.results[job.results.length - 1];
  if (!result) return null;

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text type="strong">{OPERATION_LABEL[job.operation]}</s-text>
          <s-badge tone={PROCESSING_STATUS_TONE[job.status]}>{PROCESSING_STATUS_LABEL[job.status]}</s-badge>
          <s-text color="subdued">{new Date(job.createdAt).toLocaleString()}</s-text>
        </s-stack>

        <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Original</s-text>
            <s-image src={job.sourceMedia.originalUrl} alt={job.sourceMedia.altText ?? "Original image"} />
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Processed</s-text>
            {result.url ? (
              <s-image src={result.url} alt={`Processed — ${OPERATION_LABEL[job.operation]}`} />
            ) : (
              <s-paragraph color="subdued">Not available.</s-paragraph>
            )}
          </s-stack>
        </s-grid>

        <s-text color="subdued">
          {result.format ?? "—"}
          {result.width && result.height ? ` · ${result.width}×${result.height}` : ""} ·{" "}
          {result.reviewStatus === "APPROVED" ? "Approved" : result.reviewStatus === "REJECTED" ? "Rejected" : "Not reviewed"}
        </s-text>

        <s-stack direction="inline" gap="base">
          <s-button
            variant="tertiary"
            disabled={result.reviewStatus === "APPROVED"}
            onClick={() => onReview(result.id, "APPROVED")}
          >
            Approve
          </s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            disabled={result.reviewStatus === "REJECTED"}
            onClick={() => onReview(result.id, "REJECTED")}
          >
            Reject
          </s-button>
          <s-button variant="tertiary" onClick={onRegenerate} {...(isRegenerating ? { loading: true } : {})}>
            Regenerate
          </s-button>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
