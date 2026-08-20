import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";

import { requireAdminContext } from "../../services/shopify";
import {
  createImageSelection,
  InvalidSelectionError,
} from "../../services/products/selection.server";
import { useSelection } from "../components/selection-context";

const GENERIC_CONFIRM_ERROR = "Couldn't save your selection. Please try again.";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Auth guard only — the review content itself comes from client-side
  // selection state (see app/components/selection-context.tsx); there's
  // nothing server-scoped to load until "Continue" persists the selection.
  await requireAdminContext(request);
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { context } = await requireAdminContext(request);
  const formData = await request.formData();
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
  const { summary, productCount, imageCount, entries, toggleImage, clearAll } = useSelection();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const isSaving = fetcher.state !== "idle";
  const confirmed = fetcher.data?.ok === true;

  useEffect(() => {
    if (fetcher.data && !fetcher.data.ok) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    }
  }, [fetcher.data, shopify]);

  const handleContinue = () => {
    fetcher.submit({ entries: JSON.stringify(entries) }, { method: "POST" });
  };

  if (confirmed && fetcher.data?.ok) {
    return (
      <s-page heading="Selection saved">
        <s-section>
          <s-stack direction="block" gap="base">
            <s-banner heading="Ready for the next phase" tone="success">
              <s-paragraph>
                {productCount} {productCount === 1 ? "product" : "products"} and {imageCount} source{" "}
                {imageCount === 1 ? "image" : "images"} were saved (selection ID{" "}
                {fetcher.data.selectionId}). No AI processing has started — this selection is ready
                for the next phase to pick up.
              </s-paragraph>
            </s-banner>
            <s-button
              variant="primary"
              onClick={() => {
                clearAll();
                navigate("/app/products");
              }}
            >
              Back to Products
            </s-button>
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
