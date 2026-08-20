import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireAdminContext } from "../../services/shopify";
import { findProductForShop } from "../../db/repositories/shopify-product.repository";
import { fetchProductVariants, type ProductVariant } from "../../services/products/shopify-queries.server";
import { logger } from "../../lib/logging/logger.server";
import { useSelection } from "../components/selection-context";
import { SelectionBar } from "../components/selection-bar";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, context } = await requireAdminContext(request);

  const product = await findProductForShop(context, params.id!);
  if (!product) {
    throw new Response("Product not found", { status: 404 });
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

  return { product, variants, variantsError };
};

export default function ProductDetail() {
  const { product, variants, variantsError } = useLoaderData<typeof loader>();
  const { isImageSelected, toggleImage, setProductImages, productSelectionState, selectedCountForProduct } =
    useSelection();

  const selectableProduct = { id: product.id, title: product.title, handle: product.handle };
  const imageIds = product.media.map((media) => media.id);
  const selectableImages = product.media.map((media) => ({
    id: media.id,
    url: media.previewUrl ?? media.originalUrl,
    altText: media.altText,
  }));
  const state = productSelectionState(product.id, imageIds);
  const selectedCount = selectedCountForProduct(product.id);

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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
