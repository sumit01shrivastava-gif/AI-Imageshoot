/**
 * Publishing an approved AI-generated/processed result to a Shopify
 * product's media gallery — the one Shopify Admin API WRITE this app
 * makes anywhere (see CLAUDE.md "Shopify API rules": Admin GraphQL only,
 * minimum scopes, justified in the commit).
 *
 * Uses `productCreateMedia` — the current Admin API mutation for
 * attaching new media to a product from a URL (`CreateMediaInput.originalSource`),
 * requiring the `write_products` scope. **That scope is NOT requested by
 * this app** (`shopify.app.toml`'s `[access_scopes]` still reads only
 * `read_products` — see that file's own comment and docs/publishing.md
 * "Required scope"): CLAUDE.md's constraint is explicit — "Do not add
 * Shopify write scopes until the publishing architecture is actually
 * ready for them" — and requesting a new OAuth scope forces every
 * already-installed merchant to re-consent, a real, user-facing,
 * semi-irreversible change this pass deliberately does not make
 * unilaterally. This file implements the mutation correctly against
 * Shopify's documented contract so publishing is genuinely ready the
 * moment that scope decision is made — see
 * services/publishing/job.server.ts, which calls this and reports the
 * real, honest failure Shopify's API returns today (a permission error,
 * since the installed app's offline token has no product-write grant)
 * rather than faking success.
 *
 * Called from a WORKER process (no per-request `admin` client available)
 * via `unauthenticated.admin(shop)` — Shopify's documented pattern for
 * background/offline Admin API access (see services/shopify/client.server.ts's
 * `unauthenticated` export and https://shopify.dev, "Unauthenticated
 * contexts"). Throws if the shop has no stored session (e.g. the app was
 * uninstalled) — the caller (job.server.ts) handles that the same way it
 * handles every other terminal failure.
 */
import { unauthenticated } from "./client.server";
import { executeAdminGraphQL, type AdminGraphQLClient } from "./graphql.server";

const PRODUCT_CREATE_MEDIA_MUTATION = `#graphql
  mutation PublishMediaToProduct($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        alt
        mediaContentType
        status
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

export interface PublishMediaInput {
  /** Shopify's GraphQL global product id (e.g. "gid://shopify/Product/123"). */
  shopifyProductId: string;
  /** A publicly-fetchable URL Shopify's servers can retrieve the image
   * from — a freshly-signed URL from this app's own StorageProvider (see
   * lib/storage/resign.server.ts), never a raw storageKey/filesystem
   * path (see CLAUDE.md "Storage rules"). */
  imageUrl: string;
  altText: string | null;
}

interface ProductCreateMediaResponse {
  productCreateMedia: {
    media: Array<{ id: string; alt: string | null; mediaContentType: string; status: string }>;
    mediaUserErrors: Array<{ field: string[] | null; message: string }>;
  };
}

/** Pure, network-free — builds the mutation's variables from our own
 * input shape. Kept separate from the network call so it's directly
 * unit-testable (see tests/unit/shopify/publish-media.test.ts). */
export function buildPublishMediaVariables(input: PublishMediaInput): {
  productId: string;
  media: Array<{ originalSource: string; alt: string; mediaContentType: "IMAGE" }>;
} {
  return {
    productId: input.shopifyProductId,
    media: [{ originalSource: input.imageUrl, alt: input.altText ?? "", mediaContentType: "IMAGE" }],
  };
}

export class ShopifyPublishError extends Error {
  /** `true` for a permission/scope error — the specific, expected
   * failure mode while this app requests only `read_products` (see
   * module doc comment). Lets the caller report a clearer merchant-safe
   * message than the generic publish-failure one. */
  readonly isPermissionError: boolean;

  constructor(message: string, options: { isPermissionError?: boolean } = {}) {
    super(message);
    this.name = "ShopifyPublishError";
    this.isPermissionError = options.isPermissionError ?? false;
  }
}

function looksLikePermissionError(message: string): boolean {
  return /access denied|not authorized|scope|permission/i.test(message);
}

/**
 * Calls `productCreateMedia` for one shop, using the offline (background
 * -eligible) admin client. Throws `ShopifyPublishError` on any
 * `mediaUserErrors` entry or GraphQL-level failure — never returns a
 * "sort of succeeded" result. Returns the resulting Shopify media id on
 * success.
 */
export async function publishMediaToProduct(shop: string, input: PublishMediaInput): Promise<{ shopifyMediaId: string }> {
  let admin: AdminGraphQLClient;
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch {
    throw new ShopifyPublishError(
      "Could not reach this shop's Shopify session — the app may have been uninstalled.",
      { isPermissionError: false },
    );
  }

  let data: ProductCreateMediaResponse;
  try {
    data = await executeAdminGraphQL<ProductCreateMediaResponse>(
      admin,
      PRODUCT_CREATE_MEDIA_MUTATION,
      buildPublishMediaVariables(input),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shopify publish request failed.";
    throw new ShopifyPublishError(message, { isPermissionError: looksLikePermissionError(message) });
  }

  const userErrors = data.productCreateMedia.mediaUserErrors;
  if (userErrors.length > 0) {
    const message = userErrors.map((e) => e.message).join("; ");
    throw new ShopifyPublishError(message, { isPermissionError: looksLikePermissionError(message) });
  }

  const media = data.productCreateMedia.media[0];
  if (!media) {
    throw new ShopifyPublishError("Shopify did not return the created media.");
  }

  return { shopifyMediaId: media.id };
}
