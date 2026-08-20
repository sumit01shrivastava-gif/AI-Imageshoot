# Shopify integration

## SDK and initialization

`@shopify/shopify-app-react-router` is initialized exactly once, in
`services/shopify/client.server.ts`. It configures:

- `apiKey` / `apiSecretKey` — from `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`
- `apiVersion` — currently `ApiVersion.October25`; keep in sync with
  `shopify.app.toml`'s `[webhooks].api_version`
- `scopes` — from `SHOPIFY_SCOPES` (also declared in `shopify.app.toml`'s
  `[access_scopes]`; request the minimum needed for the current phase)
- `sessionStorage` — `PrismaSessionStorage`, backed by the `Session`
  model (see docs/database.md)
- `distribution` — `AppDistribution.AppStore`

`app/shopify.server.ts` re-exports this unchanged so route modules keep
using the conventional `../shopify.server` relative import (see
docs/architecture.md).

## Access scopes

Current scope: **`read_products`** (`shopify.app.toml`'s `[access_scopes]`,
mirrored by `SHOPIFY_SCOPES` in `.env`/`.env.example`). This is
deliberately minimal for what Phase 1 actually does — catalog sync,
product/image browsing, source-image selection — all of which only ever
*read* Shopify data. See `services/products/shopify-queries.server.ts`
(every operation there is a GraphQL `query`, never a `mutation`) and
`tests/unit/shopify-scope-safety.test.ts`, which regression-tests both the
configured scope and the absence of any mutation in Phase 1 code.

`write_products` is **not** requested. It will be added — deliberately,
with its own explicit merchant consent flow designed at that time, not
silently — when a future phase publishes AI-generated media back to
Shopify. Until then, requesting it would violate CLAUDE.md's "minimum
scopes" rule for no functional benefit.

## Authenticating a request

Every loader/action that touches merchant data calls:

```ts
import { requireAdminContext } from "../../services/shopify";

const { admin, session, context } = await requireAdminContext(request);
```

`requireAdminContext` (`services/shopify/admin-context.server.ts`) wraps
`authenticate.admin`, which throws/redirects on its own for
unauthenticated or expired sessions — that's how the Shopify SDK signals
"not authenticated" (as a thrown `Response`), and this wrapper does not
catch or swallow that. `context` is a provider-agnostic `AuthContext`
(`lib/auth/types.ts`) — use `context.shop` for every shop-scoped lookup,
never a shop value read from the request body/query/params (see CLAUDE.md
"Security requirements").

`admin` exposes the authenticated Admin GraphQL client for the request.

## Admin API: GraphQL only

Use the Admin **GraphQL** API for all new functionality. Do not add new
code against the deprecated REST Admin API.

## Webhooks

Two handlers exist from the template scaffold:

- `app/routes/webhooks.app.uninstalled.tsx` — deletes the shop's session
  rows on uninstall
- `app/routes/webhooks.app.scopes_update.tsx` — updates stored session
  scope on a scope change

Both authenticate via `authenticate.webhook(request)` (verifies the
Shopify HMAC), are shop-scoped, and are safe to receive more than once
(the uninstall handler's `deleteMany` is a no-op if the session is
already gone). Any future webhook handler must follow the same pattern:
verify via `authenticate.webhook`, act idempotently, scope every write to
the shop from the verified payload.

Webhook subscriptions are declared in `shopify.app.toml`'s `[webhooks]`
block — mandatory GDPR compliance topics
(`customers/data_request`/`customers/redact`/`shop/redact`) are commented
out there and must be enabled (with handlers) before any public App Store
submission.

## Not yet built (future phases)

- Any Admin GraphQL mutation (publishing generated assets back to Shopify —
  see "Access scopes" above; this is also when `write_products` gets added)
- Billing API integration

Product/catalog synchronization (queries, sync strategy) was built in
Phase 1 — see docs/database.md and services/products/sync.server.ts.
