import { useEffect, useMemo } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import {
  listProductsForShop,
  clampPage,
  type ProductListRow,
} from "../../db/repositories/shopify-product.repository";
import { getSyncState } from "../../db/repositories/shop-sync-state.repository";
import { enqueueCatalogSync } from "../../services/products/sync-queue.server";
import { logger } from "../../lib/logging/logger.server";
import { useSelection } from "../components/selection-context";
import { SelectionBar } from "../components/selection-bar";
import type { SyncMode } from "../../services/products/types";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
] as const;

function parseStatus(value: string | null): "ACTIVE" | "ARCHIVED" | "DRAFT" | undefined {
  return value === "ACTIVE" || value === "ARCHIVED" || value === "DRAFT" ? value : undefined;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() || undefined;
  const status = parseStatus(url.searchParams.get("status"));
  const page = clampPage(Number(url.searchParams.get("page")) || 1);

  const [productPage, syncState] = await Promise.all([
    listProductsForShop(context, { search, status }, page),
    getSyncState(context.shop),
  ]);

  return {
    productPage,
    syncState,
    filters: { search: search ?? "", status: status ?? "" },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "sync") {
    const state = await getSyncState(context.shop);
    const mode: SyncMode = state?.lastSyncedAt ? "incremental" : "full";
    try {
      await enqueueCatalogSync({ type: "full-sync", shop: context.shop, mode });
      return { ok: true as const };
    } catch (error) {
      logger.error("products.sync.enqueue_failed", {
        shop: context.shop,
        error: error instanceof Error ? error.message : "unknown error",
      });
      return {
        ok: false as const,
        error: "Couldn't start a sync right now. Please try again in a moment.",
      };
    }
  }

  return { ok: false as const, error: "Unknown action." };
};

function ProductRow({ product }: { product: ProductListRow }) {
  const { setProductImages, productSelectionState, selectedCountForProduct } = useSelection();
  const imageIds = useMemo(() => product.media.map((media) => media.id), [product.media]);
  const state = productSelectionState(product.id, imageIds);
  const thumbnail = product.media[0];
  const selectableProduct = { id: product.id, title: product.title, handle: product.handle };
  const selectableImages = product.media.map((media) => ({
    id: media.id,
    url: media.previewUrl ?? media.originalUrl,
    altText: media.altText,
  }));

  return (
    <s-table-row>
      <s-table-cell>
        <s-checkbox
          accessibilityLabel={`Select all images for ${product.title}`}
          checked={state === "all"}
          indeterminate={state === "some"}
          onChange={() => setProductImages(selectableProduct, state === "all" ? [] : selectableImages)}
        />
      </s-table-cell>
      <s-table-cell>
        {thumbnail ? (
          <s-thumbnail
            src={thumbnail.previewUrl ?? thumbnail.originalUrl}
            alt={thumbnail.altText ?? product.title}
            size="small"
          />
        ) : (
          <s-thumbnail src="" alt="No image" size="small" />
        )}
      </s-table-cell>
      <s-table-cell>
        <s-link href={`/app/products/${product.id}`}>{product.title}</s-link>
      </s-table-cell>
      <s-table-cell>
        <s-text color={product.productType ? "base" : "subdued"}>{product.productType || "—"}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={product.status === "ACTIVE" ? "success" : product.status === "DRAFT" ? "info" : "neutral"}>
          {product.status.charAt(0) + product.status.slice(1).toLowerCase()}
        </s-badge>
      </s-table-cell>
      <s-table-cell>
        <s-text>{product._count.media}</s-text>
      </s-table-cell>
      <s-table-cell>
        <s-text color="subdued">
          {selectedCountForProduct(product.id) > 0
            ? `${selectedCountForProduct(product.id)} selected`
            : "—"}
        </s-text>
      </s-table-cell>
    </s-table-row>
  );
}

export default function ProductsIndex() {
  const { productPage, syncState, filters } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const syncFetcher = useFetcher<typeof action>();
  const { setProductImages, clearAll, productSelectionState } = useSelection();

  const totalPages = Math.max(1, Math.ceil(productPage.total / productPage.pageSize));
  const isSyncing = syncState?.status === "SYNCING";

  // Auto-refresh while a sync is running so "Sync in progress" clears on
  // its own once the background job finishes.
  useEffect(() => {
    if (!isSyncing) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [isSyncing, revalidator]);

  useEffect(() => {
    if (syncFetcher.data?.ok) {
      shopify.toast.show("Sync started");
    } else if (syncFetcher.data && !syncFetcher.data.ok) {
      shopify.toast.show(syncFetcher.data.error, { isError: true });
    }
  }, [syncFetcher.data, shopify]);

  const updateParam = (key: string, value: string) => {
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

  const selectAllOnPage = () => {
    for (const product of productPage.products) {
      const images = product.media.map((media) => ({
        id: media.id,
        url: media.previewUrl ?? media.originalUrl,
        altText: media.altText,
      }));
      if (images.length > 0) {
        setProductImages({ id: product.id, title: product.title, handle: product.handle }, images);
      }
    }
  };

  const allOnPageSelected =
    productPage.products.length > 0 &&
    productPage.products.every(
      (product) => productSelectionState(product.id, product.media.map((m) => m.id)) === "all",
    );

  return (
    <s-page heading="Products">
      <s-button
        slot="primary-action"
        onClick={() => syncFetcher.submit({ intent: "sync" }, { method: "POST" })}
        {...(syncFetcher.state !== "idle" || isSyncing ? { loading: true } : {})}
      >
        Sync from Shopify
      </s-button>

      <s-section>
        <s-stack direction="block" gap="base">
          {!syncState?.lastSyncedAt && !isSyncing && productPage.total === 0 && (
            <s-banner heading="No products synced yet" tone="info">
              <s-paragraph>
                Run your first sync to import your Shopify catalog. This can take a few minutes for
                large catalogs — you can keep using the app while it runs.
              </s-paragraph>
            </s-banner>
          )}
          {isSyncing && (
            <s-banner heading="Sync in progress" tone="info">
              <s-paragraph>
                Importing your catalog from Shopify. This page will refresh automatically.
              </s-paragraph>
            </s-banner>
          )}
          {syncState?.status === "FAILED" && (
            <s-banner heading="Last sync failed" tone="critical">
              <s-paragraph>{syncState.lastError ?? "Please try syncing again."}</s-paragraph>
            </s-banner>
          )}

          <SelectionBar />

          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button variant="tertiary" onClick={selectAllOnPage} disabled={allOnPageSelected}>
              Select all on this page
            </s-button>
            <s-button variant="tertiary" onClick={() => clearAll()}>
              Clear selection
            </s-button>
          </s-stack>

          <s-table
            paginate
            hasNextPage={productPage.page < totalPages}
            hasPreviousPage={productPage.page > 1}
            onNextPage={() => goToPage(productPage.page + 1)}
            onPreviousPage={() => goToPage(productPage.page - 1)}
          >
            <s-search-field
              slot="filters"
              label="Search products"
              labelAccessibilityVisibility="exclusive"
              name="q"
              placeholder="Search by title, handle, type, or vendor"
              value={filters.search}
              onChange={(event: Event) =>
                updateParam("q", (event.currentTarget as HTMLInputElement).value)
              }
            />
            <s-select
              slot="filters"
              label="Status"
              labelAccessibilityVisibility="exclusive"
              name="status"
              value={filters.status}
              onChange={(event: Event) =>
                updateParam("status", (event.currentTarget as HTMLSelectElement).value)
              }
            >
              {STATUS_OPTIONS.map((option) => (
                <s-option key={option.value || "all"} value={option.value}>
                  {option.label}
                </s-option>
              ))}
            </s-select>

            <s-table-header-row>
              <s-table-header listSlot="inline">Select</s-table-header>
              <s-table-header listSlot="inline">Image</s-table-header>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="secondary">Type</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header listSlot="secondary">Images</s-table-header>
              <s-table-header listSlot="secondary">Selected</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {productPage.products.map((product) => (
                <ProductRow key={product.id} product={product} />
              ))}
            </s-table-body>
          </s-table>

          {productPage.total === 0 && (syncState?.lastSyncedAt || filters.search || filters.status) && (
            <s-paragraph>
              No products found{filters.search ? ` for "${filters.search}"` : ""}. Try a different
              search or clear your filters.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="About this sync">
        <s-paragraph>
          Products and their images are synchronized from Shopify into AI ImageShoot so you can
          search and select them quickly. Shopify remains the source of truth — original images
          are never modified here.
        </s-paragraph>
        {syncState?.lastSyncedAt && (
          <s-paragraph>
            <s-text color="subdued">
              Last synced {new Date(syncState.lastSyncedAt).toLocaleString()}
            </s-text>
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
