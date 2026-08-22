import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { requireAdminContext } from "../../services/shopify";
import { listProductsForShop } from "../../db/repositories/shopify-product.repository";
import { getSyncState } from "../../db/repositories/shop-sync-state.repository";
import { listAssetLibrary } from "../../services/assets/asset-library.server";
import { EmptyState } from "../components/empty-state";

const RECENT_CREATIONS_LIMIT = 8;

/**
 * App home — the merchant's first screen. Answers "what can I do here?"
 * with a hero + a single primary CTA, then shows recent creations
 * (services/assets/'s cross-domain merged library) so returning
 * merchants land on their own work, not an empty dashboard. Reads
 * existing Phase 1 sync state + the asset library; introduces no new
 * feature or persisted state of its own. See CLAUDE.md's UI polish pass.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { context } = await requireAdminContext(request);

  const [syncState, productPage, recentCreations] = await Promise.all([
    getSyncState(context.shop),
    // pageSize: 1 — only `.total` is used here; the list itself belongs to
    // the Products page.
    listProductsForShop(context, {}, 1, 1),
    listAssetLibrary(context, {}, 1, RECENT_CREATIONS_LIMIT),
  ]);

  return { syncState, productCount: productPage.total, recentCreations: recentCreations.items };
};

export default function Home() {
  const { syncState, productCount, recentCreations } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const needsSync = productCount === 0;

  return (
    <s-page heading="AI Product Shoot">
      <div className="aps-hero">
        <span className="aps-hero-eyebrow">AI Product Shoot</span>
        <h1 className="aps-hero-title">Create professional product photography without a photoshoot.</h1>
        <p className="aps-hero-subtitle">
          Turn your existing Shopify product photos into lifestyle scenes, studio shots, and campaign-ready
          visuals — just describe what you want.
        </p>
        <div className="aps-hero-actions">
          <s-button variant="primary" onClick={() => navigate("/app/products")}>
            {needsSync ? "Sync products to get started" : "Create a Product Shoot"}
          </s-button>
          {!needsSync && (
            <s-button variant="tertiary" onClick={() => navigate("/app/products")}>
              Browse products
            </s-button>
          )}
        </div>
      </div>

      {needsSync ? (
        <s-section>
          <s-banner heading="Connect your catalog" tone="info">
            <s-paragraph>
              Sync your Shopify catalog to start choosing product images. Open Products and click
              &ldquo;Sync from Shopify&rdquo; to import your catalog — it only takes a moment.
            </s-paragraph>
          </s-banner>
        </s-section>
      ) : (
        <>
          {syncState?.status === "FAILED" && (
            <s-section>
              <s-banner tone="warning" heading="Catalog sync needs attention">
                <s-paragraph>Your last catalog sync didn&rsquo;t finish. Open Products to try again.</s-paragraph>
              </s-banner>
            </s-section>
          )}

          <s-section heading="Recent creations">
            {recentCreations.length === 0 ? (
              <EmptyState
                icon="🪄"
                title="No product shoots yet"
                body="Turn your product images into professional, campaign-ready visuals in minutes."
                steps={["Choose a product", "Tell AI what you want", "Get your finished image"]}
                action={
                  <s-button variant="primary" onClick={() => navigate("/app/products")}>
                    Create your first shoot
                  </s-button>
                }
              />
            ) : (
              <div className="aps-creation-grid">
                {recentCreations.map((item) =>
                  item.url ? (
                    <a
                      key={item.id}
                      className="aps-creation-card"
                      href={item.productId ? `/app/products/${item.productId}` : "/app/assets"}
                    >
                      <img src={item.url} alt={item.productTitle ?? "Generated product image"} loading="lazy" />
                      {item.productTitle && <span className="aps-creation-card-label">{item.productTitle}</span>}
                    </a>
                  ) : null,
                )}
              </div>
            )}
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
