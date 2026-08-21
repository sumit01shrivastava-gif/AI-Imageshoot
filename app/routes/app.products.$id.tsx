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
import { withResultsSanitizedForClient } from "../../lib/storage";
import {
  requestProductAnalysis,
  getProductIntelligence,
  getIntelligenceDisplayState,
  ProductNotFoundError,
  type IntelligenceDisplayState,
} from "../../services/intelligence/product-intelligence.server";
import {
  requestGeneration,
  createAndEnqueueGenerationJob,
  reviewGenerationResult,
  getGeneration,
  listGenerationHistory,
  ProductNotFoundError as GenerationProductNotFoundError,
  MissingSourceImagesError,
  ProductNotAnalyzedError,
  ProductNotModelSuitableError,
  InvalidGenerationRequestError,
  GenerationResultNotFoundError,
} from "../../services/generation/request-generation.server";
import { listAvailablePresets } from "../../services/generation/brand-style-preset.server";
import { ASPECT_RATIOS, type AspectRatioValue } from "../../services/generation/types";
import type { GenerationJobRow, GenerationResultRow } from "../../db/repositories/generation-job.repository";
import type { GenerationPlan } from "../../services/generation/schema";
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
import { useSelection } from "../components/selection-context";
import { SelectionBar } from "../components/selection-bar";
import { PublishControl, type PublishStatus } from "../components/publish-control";

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
  // repository's select already includes. Contains every generationType
  // for this product (PRODUCT_CLEANUP and LIFESTYLE both land here) — the
  // component splits it by type below.
  const generationHistory = await listGenerationHistory(context, product.id);

  // Built-in + this shop's own saved custom presets — see
  // docs/lifestyle-generation.md "Brand style presets".
  const availableBrandStylePresets = await listAvailablePresets(context);

  // Most-recent-first — see docs/image-processing.md "Versioning". Same
  // reasoning as generationHistory above: every request is its own
  // preserved row, never overwritten.
  const processingHistory = await listProcessingHistory(context, product.id);

  // Publish status for whichever result each section currently displays
  // as "the" result (job.results[job.results.length - 1], same as
  // ProductImageryResultDetail/ProcessingResultDetail below) — null when
  // there's no result yet, which PublishControl never renders for.
  // PRODUCT_CLEANUP's own "Image Generation" section (kept separate from
  // the unified "AI Product Imagery" section below) has never had an
  // Approve/Reject action — `requestPublish` requires an APPROVED
  // result, so a Publish control there could never actually be used;
  // deliberately not wired up rather than shipping a dead-end button
  // (see CLAUDE.md "UX Polish" — no placeholder buttons).
  const latestProductImageryJob =
    generationHistory.find((job) => (PRODUCT_IMAGERY_TYPES as readonly string[]).includes(job.type)) ?? null;
  const latestProcessingJob = processingHistory[0] ?? null;

  const [productImageryPublishStatus, processingPublishStatus] = await Promise.all([
    latestProductImageryJob?.results.length
      ? getLatestPublishStatus(
          context,
          "GENERATION_RESULT",
          latestProductImageryJob.results[latestProductImageryJob.results.length - 1].id,
        )
      : Promise.resolve(null),
    latestProcessingJob?.results.length
      ? getLatestPublishStatus(context, "PROCESSING_RESULT", latestProcessingJob.results[latestProcessingJob.results.length - 1].id)
      : Promise.resolve(null),
  ]);

  return {
    product,
    variants,
    variantsError,
    intelligence,
    intelligenceState,
    productImageryPublishStatus,
    processingPublishStatus,
    // See lib/storage/resign.server.ts's `withResultsSanitizedForClient`
    // doc comment — the repository select needs `storageKey` server-side
    // (to resign a fresh URL) but it must never reach the client.
    generationHistory: generationHistory.map(withResultsSanitizedForClient),
    availableBrandStylePresets,
    processingHistory: processingHistory.map(withResultsSanitizedForClient),
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
      // "Generate Image" (docs/generation.md "UI") — no image picker,
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

  if (intent === "generate-product-imagery") {
    // Structured choices only — generationType (Lifestyle/Model) and
    // preset come from fixed pickers, never a free-text prompt (see
    // docs/generation.md "No arbitrary prompts"). An unknown/empty
    // presetId is not an error: requestGeneration/resolveBrandStylePreset
    // silently falls back to category-aware defaults.
    const generationType = formData.get("generationType");
    const presetId = formData.get("presetId");
    const aspectRatio = formData.get("aspectRatio");
    if (typeof generationType !== "string" || !(PRODUCT_IMAGERY_TYPES as readonly string[]).includes(generationType)) {
      return { ok: false as const, error: "Couldn't start generation right now. Please try again." };
    }
    try {
      await requestGeneration(context, {
        productId: params.id!,
        generationType,
        presetId: typeof presetId === "string" && presetId.length > 0 ? presetId : undefined,
        aspectRatio: typeof aspectRatio === "string" && aspectRatio.length > 0 ? aspectRatio : undefined,
      });
      return { ok: true as const };
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof GenerationProductNotFoundError) {
        logger.warn("products.detail.generate_product_imagery_tenant_mismatch_or_missing", {
          shop: context.shop,
          requestedId: params.id,
        });
        throw NOT_FOUND_RESPONSE();
      }
      if (error instanceof ProductNotAnalyzedError || error instanceof ProductNotModelSuitableError) {
        return { ok: false as const, error: error.message };
      }
      if (error instanceof MissingSourceImagesError || error instanceof InvalidGenerationRequestError) {
        return { ok: false as const, error: error.message };
      }
      logger.error("products.detail.generate_product_imagery_request_failed", {
        shop: context.shop,
        productId: params.id,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return { ok: false as const, error: "Couldn't start generation right now. Please try again." };
    }
  }

  if (intent === "regenerate-product-imagery") {
    const jobId = formData.get("jobId");
    const presetId = formData.get("presetId");
    const aspectRatio = formData.get("aspectRatio");
    if (typeof jobId !== "string") {
      return { ok: false as const, error: "Couldn't start generation right now. Please try again." };
    }
    try {
      // Looked up server-side (never trusting a client-supplied product/
      // media/type) — mirrors "regenerate-processing" below: the new
      // request targets the SAME product/source images/generationType and
      // stays in the same batch (if any) as the original job. The preset/
      // aspect ratio applied are whichever the merchant currently has
      // selected in the picker (not necessarily what the original request
      // used) — see docs/lifestyle-generation.md "Regeneration".
      const original = await getGeneration(context, jobId);
      if (!original) throw NOT_FOUND_RESPONSE();

      await createAndEnqueueGenerationJob(context, {
        productId: original.productId,
        generationType: original.type,
        sourceMediaIds: original.sourceMediaIds,
        presetId: typeof presetId === "string" && presetId.length > 0 ? presetId : undefined,
        aspectRatioOverride:
          typeof aspectRatio === "string" && (ASPECT_RATIOS as readonly string[]).includes(aspectRatio)
            ? (aspectRatio as AspectRatioValue)
            : undefined,
        batchId: original.batchId ?? undefined,
      });
      return { ok: true as const };
    } catch (error) {
      if (error instanceof TenantMismatchError || error instanceof GenerationProductNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      if (
        error instanceof ProductNotAnalyzedError ||
        error instanceof ProductNotModelSuitableError ||
        error instanceof MissingSourceImagesError
      ) {
        return { ok: false as const, error: error.message };
      }
      return { ok: false as const, error: "Couldn't start generation right now. Please try again." };
    }
  }

  if (intent === "review-generation-result") {
    const resultId = formData.get("resultId");
    const decision = formData.get("decision");
    if (typeof resultId !== "string" || (decision !== "APPROVED" && decision !== "REJECTED")) {
      return { ok: false as const, error: "Couldn't complete that action right now. Please try again." };
    }
    try {
      await reviewGenerationResult(context, resultId, decision);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof GenerationResultNotFoundError) {
        throw NOT_FOUND_RESPONSE();
      }
      return { ok: false as const, error: "Couldn't complete that action right now. Please try again." };
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

  if (intent === "request-publish") {
    const sourceType = formData.get("sourceType");
    const sourceResultId = formData.get("sourceResultId");
    const targetProductId = formData.get("targetProductId");
    if (typeof sourceType !== "string" || typeof sourceResultId !== "string" || typeof targetProductId !== "string") {
      return { ok: false as const, error: "Couldn't start publishing right now. Please try again." };
    }
    try {
      await requestPublish(context, { sourceType, sourceResultId, targetProductId });
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
        return { ok: false as const, error: "That result could no longer be found." };
      }
      logger.error("products.detail.publish_failed", {
        shop: context.shop,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return { ok: false as const, error: "Couldn't start publishing right now. Please try again." };
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

// The generationTypes the "AI Product Imagery" section drives — see
// docs/lifestyle-generation.md.
const PRODUCT_IMAGERY_TYPES = ["LIFESTYLE", "MODEL_SHOOT", "BANNER", "CTA"] as const;
type ProductImageryType = (typeof PRODUCT_IMAGERY_TYPES)[number];

const GENERATION_TYPE_LABEL: Record<string, string> = {
  LIFESTYLE: "Lifestyle scene",
  MODEL_SHOOT: "Model photography",
  BANNER: "Promotional banner",
  CTA: "Call-to-action image",
};

const GENERATE_BUTTON_LABEL: Record<ProductImageryType, string> = {
  LIFESTYLE: "Generate Lifestyle Image",
  MODEL_SHOOT: "Generate Model Image",
  BANNER: "Generate Banner",
  CTA: "Generate CTA Image",
};

const ASPECT_RATIO_LABEL: Record<AspectRatioValue, string> = {
  "1:1": "Square (1:1)",
  "4:5": "Portrait (4:5)",
  "9:16": "Story (9:16)",
  "16:9": "Landscape (16:9)",
  "21:9": "Wide hero (21:9)",
};

export default function ProductDetail() {
  const {
    product,
    variants,
    variantsError,
    intelligence,
    intelligenceState,
    generationHistory,
    availableBrandStylePresets,
    processingHistory,
    productImageryPublishStatus,
    processingPublishStatus,
  } = useLoaderData<typeof loader>();
  const { isImageSelected, toggleImage, setProductImages, productSelectionState, selectedCountForProduct } =
    useSelection();
  const analyzeFetcher = useFetcher<typeof action>();
  const generateFetcher = useFetcher<typeof action>();
  const lifestyleFetcher = useFetcher<typeof action>();
  const lifestyleReviewFetcher = useFetcher<typeof action>();
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
  //
  // `generationHistory` carries every generationType for this product
  // (PRODUCT_CLEANUP and LIFESTYLE both land in the same list — see the
  // loader) — this section only concerns itself with PRODUCT_CLEANUP;
  // LIFESTYLE gets its own section/history filter below (Phase 5).
  const productCleanupHistory = generationHistory.filter((job) => job.type === "PRODUCT_CLEANUP");
  const latestGeneration = productCleanupHistory[0] ?? null;
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

  // --- AI Product Imagery (Phase 5 lifestyle scenes; Phase 6 adds model
  // imagery + aspect ratio) -------------------------------------------
  // Same "each action creates a brand-new, independently-preserved row"
  // shape as PRODUCT_CLEANUP above, scoped to this product's LIFESTYLE/
  // MODEL_SHOOT/BANNER/CTA jobs only (see productCleanupHistory's doc
  // comment for why the same `generationHistory` list needs splitting by
  // type). All four generationTypes share one section/history/state,
  // since they're the same merchant-facing feature (a preset + aspect
  // ratio picker, Generate/Regenerate, Approve/Reject) with only the
  // "what kind of imagery" choice differing.
  const productImageryHistory = generationHistory.filter((job) =>
    (PRODUCT_IMAGERY_TYPES as readonly string[]).includes(job.type),
  );
  const latestProductImagery = productImageryHistory[0] ?? null;
  const productImageryStatus = latestProductImagery?.status;
  const isTerminalProductImageryStatus =
    productImageryStatus === "SUCCEEDED" || productImageryStatus === "FAILED" || productImageryStatus === "CANCELLED";

  const [awaitingProductImagery, setAwaitingProductImagery] = useState(false);
  const isGeneratingProductImagery =
    awaitingProductImagery || (productImageryStatus !== undefined && !isTerminalProductImageryStatus);

  const [prevProductImageryStatus, setPrevProductImageryStatus] = useState(productImageryStatus);
  if (productImageryStatus !== prevProductImageryStatus) {
    setPrevProductImageryStatus(productImageryStatus);
    if (isTerminalProductImageryStatus) {
      setAwaitingProductImagery(false);
    }
  }

  const [prevProductImageryFetcherData, setPrevProductImageryFetcherData] = useState(lifestyleFetcher.data);
  if (lifestyleFetcher.data !== prevProductImageryFetcherData) {
    setPrevProductImageryFetcherData(lifestyleFetcher.data);
    if (lifestyleFetcher.data && !lifestyleFetcher.data.ok) {
      setAwaitingProductImagery(false);
    }
  }

  useEffect(() => {
    if (!awaitingProductImagery || isTerminalProductImageryStatus) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [awaitingProductImagery, isTerminalProductImageryStatus, revalidator]);

  useEffect(() => {
    if (lifestyleFetcher.data?.ok) {
      shopify.toast.show("Generation started");
    } else if (lifestyleFetcher.data && !lifestyleFetcher.data.ok) {
      shopify.toast.show(lifestyleFetcher.data.error, { isError: true });
    }
  }, [lifestyleFetcher.data, shopify]);

  useEffect(() => {
    if (lifestyleReviewFetcher.data && !lifestyleReviewFetcher.data.ok) {
      shopify.toast.show(lifestyleReviewFetcher.data.error, { isError: true });
    }
  }, [lifestyleReviewFetcher.data, shopify]);

  // Structured choices only — never a free-text prompt (see
  // docs/generation.md "No arbitrary prompts"). Empty presetId = "no
  // preset," which still produces a fully-formed scene via category-aware
  // defaults (see services/generation/lifestyle-scene.ts).
  const [productImageryType, setProductImageryType] = useState<ProductImageryType>("LIFESTYLE");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<AspectRatioValue>("1:1");

  const canGenerateModelImagery = intelligence?.modelSuitable === true;

  // A promotional banner reads best wide — nudge the aspect ratio picker
  // to match when the merchant switches to it, without taking away their
  // ability to immediately change it back.
  const changeProductImageryType = (value: ProductImageryType) => {
    setProductImageryType(value);
    if (value === "BANNER") setSelectedAspectRatio("21:9");
  };

  const requestProductImageryClick = () => {
    setAwaitingProductImagery(true);
    lifestyleFetcher.submit(
      { intent: "generate-product-imagery", generationType: productImageryType, presetId: selectedPresetId, aspectRatio: selectedAspectRatio },
      { method: "POST" },
    );
  };

  const regenerateProductImagery = (jobId: string) => {
    setAwaitingProductImagery(true);
    lifestyleFetcher.submit(
      { intent: "regenerate-product-imagery", jobId, presetId: selectedPresetId, aspectRatio: selectedAspectRatio },
      { method: "POST" },
    );
  };

  const reviewProductImageryResult = (resultId: string, decision: "APPROVED" | "REJECTED") => {
    lifestyleReviewFetcher.submit({ intent: "review-generation-result", resultId, decision }, { method: "POST" });
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
              {latestGeneration ? "Regenerate" : "Generate Image"}
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
            <s-paragraph color="subdued">No image generated yet.</s-paragraph>
          )}

          {generationStatus === "SUCCEEDED" && latestGeneration && (
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
              {latestGeneration.results.map((result, index) => (
                <GenerationResultCard key={result.id} result={result} index={index} />
              ))}
            </s-grid>
          )}

          {productCleanupHistory.length > 1 && (
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Generation history</s-text>
              <s-stack direction="block" gap="small-200">
                {productCleanupHistory.map((job, index) => (
                  <s-paragraph key={job.id}>
                    Generation #{productCleanupHistory.length - index} —{" "}
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

      <s-section heading="AI Product Imagery">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Places this product in a photorealistic lifestyle scene, model photograph, promotional
            banner, or call-to-action image — built from its Product Intelligence profile and a
            brand style preset, never a free-text prompt. The original product image is never
            modified; every generation is a new, separately reviewable result.
          </s-text>

          <s-select
            label="Style"
            labelAccessibilityVisibility="visible"
            value={productImageryType}
            onChange={(event: Event) =>
              changeProductImageryType((event.currentTarget as HTMLSelectElement).value as ProductImageryType)
            }
          >
            <s-option value="LIFESTYLE">Lifestyle scene</s-option>
            <s-option value="MODEL_SHOOT" disabled={!canGenerateModelImagery}>
              Model photography{!canGenerateModelImagery ? " (not suited to this product)" : ""}
            </s-option>
            <s-option value="BANNER">Promotional banner</s-option>
            <s-option value="CTA">Call-to-action image</s-option>
          </s-select>

          <s-select
            label="Brand style"
            labelAccessibilityVisibility="visible"
            value={selectedPresetId}
            onChange={(event: Event) => setSelectedPresetId((event.currentTarget as HTMLSelectElement).value)}
          >
            <s-option value="">No preset — category defaults</s-option>
            {availableBrandStylePresets.map((preset) => (
              <s-option key={preset.id} value={preset.id}>
                {preset.name}
                {preset.isCustom ? " (custom)" : ""}
              </s-option>
            ))}
          </s-select>

          <s-select
            label="Aspect ratio"
            labelAccessibilityVisibility="visible"
            value={selectedAspectRatio}
            onChange={(event: Event) =>
              setSelectedAspectRatio((event.currentTarget as HTMLSelectElement).value as AspectRatioValue)
            }
          >
            {ASPECT_RATIOS.map((ratio) => (
              <s-option key={ratio} value={ratio}>
                {ASPECT_RATIO_LABEL[ratio]}
              </s-option>
            ))}
          </s-select>

          <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
            {productImageryStatus ? (
              <s-badge tone={GENERATION_STATUS_TONE[productImageryStatus]}>
                {GENERATION_STATUS_LABEL[productImageryStatus]}
              </s-badge>
            ) : (
              <s-badge tone="info">Not generated yet</s-badge>
            )}
            {/* Only offered while there's no succeeded result to regenerate
                from yet — once one exists, ProductImageryResultDetail's own
                "Regenerate" below is the single place that action lives
                (avoids two controls both labeled "Regenerate" doing
                near-identical things — see docs/lifestyle-generation.md
                "Review, regeneration, and generation history"). */}
            {productImageryStatus !== "SUCCEEDED" && (
              <s-button
                variant="primary"
                onClick={requestProductImageryClick}
                disabled={
                  isGeneratingProductImagery || !canGenerate || (productImageryType === "MODEL_SHOOT" && !canGenerateModelImagery)
                }
                {...(isGeneratingProductImagery ? { loading: true } : {})}
              >
                {GENERATE_BUTTON_LABEL[productImageryType]}
              </s-button>
            )}
          </s-stack>

          {!canGenerate && (
            <s-paragraph color="subdued">
              Analyze this product (see Product Intelligence above) before generating product
              imagery.
            </s-paragraph>
          )}

          {canGenerate && productImageryType === "MODEL_SHOOT" && !canGenerateModelImagery && (
            <s-paragraph color="subdued">
              This product&rsquo;s Product Intelligence profile doesn&rsquo;t recommend model
              photography for it — try a lifestyle scene instead.
            </s-paragraph>
          )}

          {productImageryStatus === "FAILED" && (
            <s-banner tone="critical">
              <s-paragraph>{latestProductImagery?.errorMessage ?? "Generation failed."}</s-paragraph>
            </s-banner>
          )}

          {productImageryStatus === "SUCCEEDED" && latestProductImagery && (
            <ProductImageryResultDetail
              job={latestProductImagery}
              onReview={reviewProductImageryResult}
              onRegenerate={() => regenerateProductImagery(latestProductImagery.id)}
              isRegenerating={isGeneratingProductImagery}
              productId={product.id}
              productTitle={product.title}
              publishStatus={productImageryPublishStatus}
            />
          )}

          {productImageryHistory.length > 1 && (
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">Generation history</s-text>
              <s-stack direction="block" gap="small-200">
                {productImageryHistory.map((job, index) => (
                  <s-paragraph key={job.id}>
                    Generation #{productImageryHistory.length - index} — {GENERATION_TYPE_LABEL[job.type] ?? job.type}{" "}
                    <s-badge tone={GENERATION_STATUS_TONE[job.status]}>{GENERATION_STATUS_LABEL[job.status]}</s-badge>{" "}
                    {job.results[job.results.length - 1] && (
                      <>
                        {job.results[job.results.length - 1].reviewStatus === "APPROVED"
                          ? "Approved"
                          : job.results[job.results.length - 1].reviewStatus === "REJECTED"
                            ? "Rejected"
                            : "Not reviewed"}{" "}
                      </>
                    )}
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
                productId={product.id}
                productTitle={product.title}
                publishStatus={processingPublishStatus}
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
 * The detailed "latest result" card for AI Product Imagery (LIFESTYLE or
 * MODEL_SHOOT) — original (from the plan's own `sourceImages` snapshot —
 * GenerationJob has no single `sourceMedia` relation the way ProcessingJob
 * does, since a generation's `sourceMediaIds` is an array; see
 * prisma/schema.prisma's model comment) vs. generated, with
 * Approve/Reject/Regenerate. Mirrors ProcessingResultDetail below
 * field-for-field.
 */
function ProductImageryResultDetail({
  job,
  onReview,
  onRegenerate,
  isRegenerating,
  productId,
  productTitle,
  publishStatus,
}: {
  job: GenerationJobRow;
  onReview: (resultId: string, decision: "APPROVED" | "REJECTED") => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
  productId: string;
  productTitle: string;
  publishStatus: PublishStatus | null;
}) {
  const result: GenerationResultRow | undefined = job.results[job.results.length - 1];
  if (!result) return null;
  const plan = job.plan as unknown as GenerationPlan;
  const original = plan.sourceImages[0];

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" borderColor="subdued">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={GENERATION_STATUS_TONE[job.status]}>{GENERATION_STATUS_LABEL[job.status]}</s-badge>
          <s-text color="subdued">{GENERATION_TYPE_LABEL[job.type] ?? job.type}</s-text>
          <s-text color="subdued">{plan.aspectRatio}</s-text>
          <s-text color="subdued">{new Date(job.createdAt).toLocaleString()}</s-text>
        </s-stack>

        <s-grid gridTemplateColumns="repeat(2, minmax(160px, 1fr))" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Original</s-text>
            {original ? (
              <s-image src={original.url} alt={original.altText ?? "Original image"} />
            ) : (
              <s-paragraph color="subdued">Not available.</s-paragraph>
            )}
          </s-stack>
          <s-stack direction="block" gap="small-200">
            <s-text color="subdued">Result</s-text>
            {result.url ? (
              <s-image src={result.url} alt="Generation result" />
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

        {result.reviewStatus === "APPROVED" && (
          <PublishControl
            sourceType="GENERATION_RESULT"
            sourceResultId={result.id}
            candidateProducts={[{ productId, title: productTitle }]}
            publishStatus={publishStatus}
          />
        )}
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
  productId,
  productTitle,
  publishStatus,
}: {
  job: ProcessingJobRow;
  onReview: (resultId: string, decision: "APPROVED" | "REJECTED") => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
  productId: string;
  productTitle: string;
  publishStatus: PublishStatus | null;
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

        {result.reviewStatus === "APPROVED" && (
          <PublishControl
            sourceType="PROCESSING_RESULT"
            sourceResultId={result.id}
            candidateProducts={[{ productId, title: productTitle }]}
            publishStatus={publishStatus}
          />
        )}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
