import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import {
  createImageSelection,
  InvalidSelectionError,
} from "../../services/products/selection.server";
import {
  startBatchProcessing,
  InvalidBatchRequestError as InvalidProcessingBatchRequestError,
  SelectionNotFoundError as ProcessingSelectionNotFoundError,
} from "../../services/processing/batch.server";
import { IMPLEMENTED_OPERATIONS, type ImageOperationValue } from "../../services/processing/types";
import {
  startBatchGeneration,
  InvalidBatchRequestError as InvalidGenerationBatchRequestError,
  SelectionNotFoundError as GenerationSelectionNotFoundError,
} from "../../services/generation/batch.server";
import { listAvailablePresets } from "../../services/generation/brand-style-preset.server";
import { useSelection } from "../components/selection-context";

const GENERIC_CONFIRM_ERROR = "Couldn't save your selection. Please try again.";
const GENERIC_START_ERROR = "Couldn't start processing right now. Please try again.";
const GENERIC_START_GENERATION_ERROR = "Couldn't start generation right now. Please try again.";

const OPERATION_LABEL: Record<ImageOperationValue, string> = {
  REMOVE_BACKGROUND: "Remove background",
  ENHANCE: "Enhance (sharpen + lighting)",
  UPSCALE: "Upscale",
  GENERATE_SHADOW: "Add shadow",
  RESIZE: "Resize (aspect ratio)",
  CROP: "Crop",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Auth guard only — the review content itself comes from client-side
  // selection state (see app/components/selection-context.tsx); there's
  // nothing server-scoped to load until "Continue" persists the selection.
  const { context } = await requireAdminContext(request);
  // Built-in + this shop's own saved custom presets, for the "Generate
  // lifestyle imagery" mode's preset picker — see
  // docs/lifestyle-generation.md "Brand style presets".
  const availableBrandStylePresets = await listAvailablePresets(context);
  return { availableBrandStylePresets };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "start-processing") {
    const selectionId = formData.get("selectionId");
    const operation = formData.get("operation");
    if (typeof selectionId !== "string" || typeof operation !== "string") {
      return { ok: false as const, error: GENERIC_START_ERROR };
    }
    try {
      const { batchId } = await startBatchProcessing(context, { selectionId, operation });
      return redirect(`/app/processing/${batchId}`);
    } catch (error) {
      const message =
        error instanceof InvalidProcessingBatchRequestError || error instanceof ProcessingSelectionNotFoundError
          ? error.message
          : GENERIC_START_ERROR;
      return { ok: false as const, error: message };
    }
  }

  if (intent === "start-lifestyle-batch") {
    const selectionId = formData.get("selectionId");
    const presetId = formData.get("presetId");
    if (typeof selectionId !== "string") {
      return { ok: false as const, error: GENERIC_START_GENERATION_ERROR };
    }
    try {
      const { batchId } = await startBatchGeneration(context, {
        selectionId,
        generationType: "LIFESTYLE",
        presetId: typeof presetId === "string" && presetId.length > 0 ? presetId : undefined,
      });
      return redirect(`/app/generation/${batchId}`);
    } catch (error) {
      const message =
        error instanceof InvalidGenerationBatchRequestError || error instanceof GenerationSelectionNotFoundError
          ? error.message
          : GENERIC_START_GENERATION_ERROR;
      return { ok: false as const, error: message };
    }
  }

  // Default / "confirm": persist the client-side selection as an
  // ImageSelection — see services/products/selection.server.ts.
  const raw = formData.get("entries");

  let entries: Array<{ productId: string; productMediaId: string }> = [];
  try {
    const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : "[]");
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (item): item is { productId: string; productMediaId: string } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).productId === "string" &&
          typeof (item as Record<string, unknown>).productMediaId === "string",
      )
    ) {
      entries = parsed;
    }
  } catch {
    return { ok: false as const, error: "Your selection could not be read. Please try again." };
  }

  try {
    const selectionId = await createImageSelection(context, entries);
    return { ok: true as const, selectionId };
  } catch (error) {
    const message = error instanceof InvalidSelectionError ? error.message : GENERIC_CONFIRM_ERROR;
    return { ok: false as const, error: message };
  }
};

export default function ProductsSelection() {
  const { availableBrandStylePresets } = useLoaderData<typeof loader>();
  const { summary, productCount, imageCount, entries, toggleImage, clearAll } = useSelection();
  const fetcher = useFetcher<typeof action>();
  const startFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSaving = fetcher.state !== "idle";
  const isStarting = startFetcher.state !== "idle";
  const confirmed = fetcher.data?.ok === true;
  const [mode, setMode] = useState<"process" | "generate-lifestyle">("process");
  const [operation, setOperation] = useState<ImageOperationValue>("REMOVE_BACKGROUND");
  const [presetId, setPresetId] = useState("");

  useEffect(() => {
    if (fetcher.data && !fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  useEffect(() => {
    if (startFetcher.data && !startFetcher.data.ok) {
      shopify.toast.show(startFetcher.data.error, { isError: true });
    }
  }, [startFetcher.data, shopify]);

  const handleContinue = () => {
    fetcher.submit({ entries: JSON.stringify(entries) }, { method: "POST" });
  };

  const handleStartProcessing = (selectionId: string) => {
    startFetcher.submit({ intent: "start-processing", selectionId, operation }, { method: "POST" });
  };

  const handleStartLifestyleBatch = (selectionId: string) => {
    startFetcher.submit({ intent: "start-lifestyle-batch", selectionId, presetId }, { method: "POST" });
  };

  if (confirmed && fetcher.data?.ok) {
    const selectionId = fetcher.data.selectionId;
    return (
      <s-page heading="Selection saved">
        <s-section>
          <s-stack direction="block" gap="large">
            <s-banner heading="Ready to process" tone="success">
              <s-paragraph>
                {productCount} {productCount === 1 ? "product" : "products"} and {imageCount} source{" "}
                {imageCount === 1 ? "image" : "images"} were saved (selection ID {selectionId}).
              </s-paragraph>
            </s-banner>

            <s-stack direction="block" gap="base">
              <s-heading>What do you want to do with these images?</s-heading>
              <s-select
                label="Mode"
                labelAccessibilityVisibility="visible"
                value={mode}
                onChange={(event: Event) =>
                  setMode((event.currentTarget as HTMLSelectElement).value as "process" | "generate-lifestyle")
                }
              >
                <s-option value="process">Process images (background removal, enhance, resize…)</s-option>
                <s-option value="generate-lifestyle">Generate lifestyle imagery</s-option>
              </s-select>

              {mode === "process" ? (
                <s-select
                  label="Operation"
                  labelAccessibilityVisibility="visible"
                  value={operation}
                  onChange={(event: Event) =>
                    setOperation((event.currentTarget as HTMLSelectElement).value as ImageOperationValue)
                  }
                >
                  {IMPLEMENTED_OPERATIONS.map((value) => (
                    <s-option key={value} value={value}>
                      {OPERATION_LABEL[value]}
                    </s-option>
                  ))}
                </s-select>
              ) : (
                <s-select
                  label="Brand style"
                  labelAccessibilityVisibility="visible"
                  value={presetId}
                  onChange={(event: Event) => setPresetId((event.currentTarget as HTMLSelectElement).value)}
                >
                  <s-option value="">No preset — category defaults</s-option>
                  {availableBrandStylePresets.map((preset) => (
                    <s-option key={preset.id} value={preset.id}>
                      {preset.name}
                      {preset.isCustom ? " (custom)" : ""}
                    </s-option>
                  ))}
                </s-select>
              )}

              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  onClick={() =>
                    mode === "process"
                      ? handleStartProcessing(selectionId)
                      : handleStartLifestyleBatch(selectionId)
                  }
                  {...(isStarting ? { loading: true } : {})}
                >
                  {mode === "process" ? "Start processing" : "Start generating"}
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    clearAll();
                    navigate("/app/products");
                  }}
                >
                  Back to Products
                </s-button>
              </s-stack>
            </s-stack>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Review selection">
      <s-link slot="breadcrumb-actions" href="/app/products">
        Products
      </s-link>

      <s-section>
        {imageCount === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              No images selected yet. Go back to Products and choose one or more images from any
              product.
            </s-paragraph>
            <s-button onClick={() => navigate("/app/products")}>Back to Products</s-button>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="large">
            <s-banner tone="info">
              <s-paragraph>
                Selected: {productCount} {productCount === 1 ? "product" : "products"}, {imageCount}{" "}
                source {imageCount === 1 ? "image" : "images"}.
              </s-paragraph>
            </s-banner>

            {summary.map(({ product, images }) => (
              <s-stack key={product.id} direction="block" gap="small-200">
                <s-heading>
                  {product.title} ({images.length})
                </s-heading>
                <s-grid gridTemplateColumns="repeat(auto-fill, minmax(120px, 1fr))" gap="small-200">
                  {images.map((image) => (
                    <s-box key={image.id} padding="small-200" borderWidth="base" borderRadius="base">
                      <s-stack direction="block" gap="small-200">
                        <s-image src={image.url} alt={image.altText ?? product.title} />
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() => toggleImage(product, image)}
                        >
                          Remove
                        </s-button>
                      </s-stack>
                    </s-box>
                  ))}
                </s-grid>
              </s-stack>
            ))}

            <s-stack direction="inline" gap="base">
              <s-button variant="tertiary" onClick={() => clearAll()}>
                Clear selection
              </s-button>
              <s-button variant="primary" onClick={handleContinue} {...(isSaving ? { loading: true } : {})}>
                Continue
              </s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
