import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireAdminContext } from "../../services/shopify";
import { listProductsForShop } from "../../db/repositories/shopify-product.repository";
import { getSyncState } from "../../db/repositories/shop-sync-state.repository";

/**
 * App home — a clean entry point into the Products workflow (catalog sync,
 * image selection). Replaces the Shopify template's productCreate demo
 * (see the Phase 1 cleanup security audit) — this page reads existing
 * Phase 1 data (sync status, product count) to show a useful at-a-glance
 * state; it doesn't introduce any new feature, analytics, or dashboard.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);

  const [syncState, productPage] = await Promise.all([
    getSyncState(context.shop),
    // pageSize: 1 — only `.total` is used here; the list itself belongs to
    // the Products page.
    listProductsForShop(context, {}, 1, 1),
  ]);

  return { syncState, productCount: productPage.total };
};

export default function Home() {
  const { syncState, productCount } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <s-page heading="AI ImageShoot">
      <s-button slot="primary-action" onClick={() => navigate("/app/products")}>
        Start with Products
      </s-button>

      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>Create better product imagery with AI.</s-paragraph>

          {productCount === 0 ? (
            <s-banner heading="Get started" tone="info">
              <s-paragraph>
                Sync your Shopify catalog to start selecting product images. Open Products and
                click &ldquo;Sync from Shopify&rdquo; to import your catalog.
              </s-paragraph>
            </s-banner>
          ) : (
            <s-stack direction="block" gap="small-200">
              <s-text>
                {productCount} {productCount === 1 ? "product" : "products"} synced from Shopify
              </s-text>
              {syncState?.lastSyncedAt && (
                <s-text color="subdued">
                  Last synced {new Date(syncState.lastSyncedAt).toLocaleString()}
                </s-text>
              )}
              {syncState?.status === "FAILED" && (
                <s-text tone="critical">Last sync failed — open Products to try again.</s-text>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
