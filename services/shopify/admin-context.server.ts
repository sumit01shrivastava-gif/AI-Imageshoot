/**
 * The single server-side entry point for "this request must be an
 * authenticated Shopify admin request".
 *
 * Every loader/action that touches merchant data must call
 * `requireAdminContext(request)` and use the returned `context.shop` (never
 * a shop value read from the request body/query/params) for any
 * shop-scoped lookup — see lib/auth/tenant.server.ts.
 *
 * This wraps `authenticate.admin`, which throws/redirects on its own for
 * unauthenticated or expired sessions (that's how the Shopify SDK signals
 * "not authenticated" — as a thrown Response). We intentionally do not
 * catch that here: swallowing it would defeat the protection.
 */
import type { AuthContext } from "../../lib/auth/types";
import { authenticate } from "./client.server";

type AdminAuthResult = Awaited<ReturnType<typeof authenticate.admin>>;

export interface AdminRequestContext {
  /** Provider-agnostic auth context — pass this to shop-scoped services/repositories. */
  context: AuthContext;
  /** Authenticated Shopify Admin GraphQL/REST clients for this request. */
  admin: AdminAuthResult["admin"];
  /** Raw Shopify session, for the rare case a caller needs a field AuthContext doesn't expose. */
  session: AdminAuthResult["session"];
}

export async function requireAdminContext(request: Request): Promise<AdminRequestContext> {
  const { admin, session } = await authenticate.admin(request);

  return {
    admin,
    session,
    context: {
      shop: session.shop,
      sessionId: session.id,
      isOnline: session.isOnline,
    },
  };
}
