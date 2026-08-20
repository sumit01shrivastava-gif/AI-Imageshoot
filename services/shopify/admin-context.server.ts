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
import { getEnv } from "../../lib/validation/env.server";
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

/**
 * E2E test seam — see tests/e2e/products.spec.ts and playwright.config.ts.
 *
 * Real Shopify OAuth cannot run in an automated test (CLAUDE.md: "Never
 * call a live/production Shopify store... from automated tests"), but every
 * `/app/*` route requires an authenticated admin context to render at all.
 * This lets the Playwright suite stand in a fake context for one specific,
 * test-seeded shop, instead of calling `authenticate.admin`.
 *
 * Three independent conditions must ALL hold before this does anything:
 *   1. `NODE_ENV === "test"` — never true in development or production.
 *   2. `ALLOW_E2E_AUTH_BYPASS === "1"` — a second, explicit opt-in, set only
 *      by playwright.config.ts's webServer env, never by .env/.env.example.
 *   3. The request itself carries the `x-ai-imageshoot-e2e-shop` header —
 *      normal requests (including every other automated test) never send
 *      this, so this is inert everywhere except the e2e suite.
 *
 * The returned `admin.graphql` is a stub that always errors — Phase 1's
 * only live GraphQL call from a loader (product detail's variants fetch)
 * already treats that as a non-fatal, handled failure, so e2e coverage of
 * the UI doesn't require faking real Shopify API responses.
 */
const E2E_TEST_SHOP_HEADER = "x-ai-imageshoot-e2e-shop";

function readE2ETestShop(request: Request): string | null {
  if (getEnv().NODE_ENV !== "test" || getEnv().ALLOW_E2E_AUTH_BYPASS !== "1") {
    return null;
  }
  return request.headers.get(E2E_TEST_SHOP_HEADER);
}

function buildE2ETestContext(shop: string): AdminRequestContext {
  const fakeAdmin = {
    graphql: async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "E2E test double — no live Shopify API access." }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    // Deliberately minimal: our code only ever calls `admin.graphql`. This
    // cast satisfies the SDK's wider AdminApiContext type without
    // implementing REST/webhook methods no Phase 1 code path uses.
  } as unknown as AdminAuthResult["admin"];

  const fakeSession = {
    shop,
    id: `e2e-test:${shop}`,
    isOnline: false,
  } as unknown as AdminAuthResult["session"];

  return {
    admin: fakeAdmin,
    session: fakeSession,
    context: { shop, sessionId: fakeSession.id, isOnline: false },
  };
}

export async function requireAdminContext(request: Request): Promise<AdminRequestContext> {
  const e2eTestShop = readE2ETestShop(request);
  if (e2eTestShop) {
    return buildE2ETestContext(e2eTestShop);
  }

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
