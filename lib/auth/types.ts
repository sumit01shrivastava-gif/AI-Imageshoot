/**
 * Provider-agnostic authentication context.
 *
 * This type is intentionally decoupled from Shopify's own session/admin
 * types — it's what the rest of the codebase (repositories, services,
 * queue jobs) should depend on, so that "how a request got authenticated"
 * stays isolated inside services/shopify. See docs/architecture.md.
 */
export interface AuthContext {
  /** The shop domain that owns this request, e.g. "my-shop.myshopify.com". */
  shop: string;
  /** The underlying session id, for audit/log correlation only. */
  sessionId: string;
  /** Whether this is an online (user) session vs. an offline (background) one. */
  isOnline: boolean;
}
