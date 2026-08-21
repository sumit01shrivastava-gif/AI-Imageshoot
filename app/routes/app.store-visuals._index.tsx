/**
 * Store visuals — "create new" form (homepage hero / collection banner /
 * store CTA). See docs/store-visuals.md. The merchant picks a visual
 * type, a brand style preset, an aspect ratio, and optionally features
 * zero, one, or several of their own products — never a free-text prompt
 * (see docs/generation.md "No arbitrary prompts"). Submitting redirects
 * into app/routes/app.store-visuals.$jobId.tsx for progress/review.
 *
 * Browsing PAST store visuals lives on the Asset Library
 * (app/routes/app.assets.tsx), not here — this route is deliberately
 * create-only, mirroring how app/routes/app.products.selection.tsx is the
 * "start a batch" screen, not a batch history screen.
 */
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import { listProductsForShop, clampPage } from "../../db/repositories/shopify-product.repository";
import { getShopSettings } from "../../db/repositories/shop-settings.repository";
import { listAvailablePresets } from "../../services/generation/brand-style-preset.server";
import {
  requestStoreVisual,
  InvalidStoreVisualRequestError,
  ProductNotFoundError,
} from "../../services/store-visuals/request-store-visual.server";
import { STORE_VISUAL_TYPES, ASPECT_RATIOS, type StoreVisualTypeValue, type AspectRatioValue } from "../../services/store-visuals/types";
import { logger } from "../../lib/logging/logger.server";

const VISUAL_TYPE_LABEL: Record<StoreVisualTypeValue, string> = {
  HOMEPAGE_HERO: "Homepage hero",
  COLLECTION_BANNER: "Collection banner",
  STORE_CTA: "Store call-to-action",
};

const ASPECT_RATIO_LABEL: Record<AspectRatioValue, string> = {
  "1:1": "Square (1:1)",
  "4:5": "Portrait (4:5)",
  "9:16": "Story (9:16)",
  "16:9": "Landscape (16:9)",
  "21:9": "Wide hero (21:9)",
};

const PRODUCT_PICKER_PAGE_SIZE = 8;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() || undefined;
  const page = clampPage(Number(url.searchParams.get("page")) || 1);

  const [availableBrandStylePresets, shopSettings, productPage] = await Promise.all([
    listAvailablePresets(context),
    getShopSettings(context.shop),
    listProductsForShop(context, { search }, page, PRODUCT_PICKER_PAGE_SIZE),
  ]);

  return {
    availableBrandStylePresets,
    defaultPresetId: shopSettings?.defaultBrandStylePresetId ?? "",
    productPage,
    search: search ?? "",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();

  const visualType = formData.get("visualType");
  const presetId = formData.get("presetId");
  const aspectRatio = formData.get("aspectRatio");
  const productIdsRaw = formData.get("productIds");

  let productIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(typeof productIdsRaw === "string" ? productIdsRaw : "[]");
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      productIds = parsed;
    }
  } catch {
    return { ok: false as const, error: "Your product selection could not be read. Please try again." };
  }

  try {
    const job = await requestStoreVisual(context, {
      visualType: typeof visualType === "string" ? visualType : "",
      productIds,
      presetId: typeof presetId === "string" && presetId.length > 0 ? presetId : undefined,
      aspectRatio: typeof aspectRatio === "string" && aspectRatio.length > 0 ? aspectRatio : undefined,
    });
    return redirect(`/app/store-visuals/${job.id}`);
  } catch (error) {
    if (error instanceof InvalidStoreVisualRequestError) {
      return { ok: false as const, error: error.message };
    }
    if (error instanceof ProductNotFoundError) {
      return { ok: false as const, error: "One of the selected products could not be found. Please try again." };
    }
    logger.error("store_visuals.create_failed", {
      shop: context.shop,
      error: error instanceof Error ? error.message : "unknown error",
    });
    return { ok: false as const, error: "Couldn't start generation right now. Please try again." };
  }
};

export default function StoreVisualsNew() {
  const { availableBrandStylePresets, defaultPresetId, productPage, search } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [visualType, setVisualType] = useState<StoreVisualTypeValue>("HOMEPAGE_HERO");
  const [presetId, setPresetId] = useState(defaultPresetId);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioValue>(visualType === "STORE_CTA" ? "1:1" : "21:9");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [selectedProductTitles, setSelectedProductTitles] = useState<Record<string, string>>({});

  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data && !fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const changeVisualType = (value: StoreVisualTypeValue) => {
    setVisualType(value);
    setAspectRatio(value === "STORE_CTA" ? "1:1" : "21:9");
  };

  const toggleProduct = (id: string, title: string) => {
    setSelectedProductIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
    setSelectedProductTitles((current) => ({ ...current, [id]: title }));
  };

  const updateSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("q", value);
    else next.delete("q");
    next.delete("page");
    setSearchParams(next);
  };

  const totalPages = Math.max(1, Math.ceil(productPage.total / productPage.pageSize));
  const goToPage = (page: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(page));
    setSearchParams(next);
  };

  const handleSubmit = () => {
    fetcher.submit(
      {
        visualType,
        presetId,
        aspectRatio,
        productIds: JSON.stringify(selectedProductIds),
      },
      { method: "POST" },
    );
  };

  return (
    <s-page heading="Create a store visual">
      <s-link slot="breadcrumb-actions" href="/app/assets">
        AI Assets
      </s-link>

      <s-section heading="Store Visuals">
        <s-stack direction="block" gap="base">
          <s-text color="subdued">
            Generates a homepage hero, collection banner, or store call-to-action image — built from
            a brand style preset and, optionally, one or more of your own products. Never a
            free-text prompt, and never any rendered text/logos in the result (compose your own
            copy over it in Shopify&rsquo;s theme editor). Original product images are never modified.
          </s-text>

          <s-select
            label="Visual type"
            labelAccessibilityVisibility="visible"
            value={visualType}
            onChange={(event: Event) => changeVisualType((event.currentTarget as HTMLSelectElement).value as StoreVisualTypeValue)}
          >
            {STORE_VISUAL_TYPES.map((type) => (
              <s-option key={type} value={type}>
                {VISUAL_TYPE_LABEL[type]}
              </s-option>
            ))}
          </s-select>

          <s-select
            label="Brand style"
            labelAccessibilityVisibility="visible"
            value={presetId}
            onChange={(event: Event) => setPresetId((event.currentTarget as HTMLSelectElement).value)}
          >
            <s-option value="">No preset — generic styling</s-option>
            {availableBrandStylePresets.map((preset) => (
              <s-option key={preset.id} value={preset.id}>
                {preset.name}
                {preset.isCustom ? " (custom)" : ""}
                {preset.id === defaultPresetId ? " — default" : ""}
              </s-option>
            ))}
          </s-select>

          <s-select
            label="Aspect ratio"
            labelAccessibilityVisibility="visible"
            value={aspectRatio}
            onChange={(event: Event) => setAspectRatio((event.currentTarget as HTMLSelectElement).value as AspectRatioValue)}
          >
            {ASPECT_RATIOS.map((ratio) => (
              <s-option key={ratio} value={ratio}>
                {ASPECT_RATIO_LABEL[ratio]}
              </s-option>
            ))}
          </s-select>

          <s-stack direction="block" gap="small-200">
            <s-heading>Feature specific products (optional)</s-heading>
            {selectedProductIds.length > 0 && (
              <s-text color="subdued">
                Selected: {selectedProductIds.map((id) => selectedProductTitles[id]).filter(Boolean).join(", ")}
              </s-text>
            )}
            <s-search-field
              label="Search products"
              labelAccessibilityVisibility="exclusive"
              name="q"
              placeholder="Search by title, handle, type, or vendor"
              value={search}
              onChange={(event: Event) => updateSearch((event.currentTarget as HTMLInputElement).value)}
            />
            <s-table
              paginate
              hasNextPage={productPage.page < totalPages}
              hasPreviousPage={productPage.page > 1}
              onNextPage={() => goToPage(productPage.page + 1)}
              onPreviousPage={() => goToPage(productPage.page - 1)}
            >
              <s-table-header-row>
                <s-table-header listSlot="inline">Feature</s-table-header>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="secondary">Type</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {productPage.products.map((product) => (
                  <s-table-row key={product.id}>
                    <s-table-cell>
                      <s-checkbox
                        accessibilityLabel={`Feature ${product.title}`}
                        checked={selectedProductIds.includes(product.id)}
                        onChange={() => toggleProduct(product.id, product.title)}
                      />
                    </s-table-cell>
                    <s-table-cell>{product.title}</s-table-cell>
                    <s-table-cell>{product.productType || "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
            {productPage.total === 0 && <s-paragraph color="subdued">No products found.</s-paragraph>}
          </s-stack>

          {fetcher.data && !fetcher.data.ok && (
            <s-banner tone="critical">
              <s-paragraph>{fetcher.data.error}</s-paragraph>
            </s-banner>
          )}

          <s-button variant="primary" onClick={handleSubmit} disabled={isSubmitting} {...(isSubmitting ? { loading: true } : {})}>
            Generate {VISUAL_TYPE_LABEL[visualType]}
          </s-button>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
