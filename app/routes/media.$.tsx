/**
 * Serves a stored object's bytes for a signed `/media/<key>` URL — see
 * lib/storage/local-filesystem-provider.server.ts's `getSignedUrl` (which
 * builds these URLs) and `verifyMediaUrlSignature` (which this route
 * calls to check them).
 *
 * Deliberately a TOP-LEVEL route (`media.$.tsx`, sibling to `auth.$.tsx`/
 * `webhooks.*.tsx`) — NOT nested under `app.tsx`, whose loader calls
 * `requireAdminContext` (Shopify session-token auth) for every route that
 * nests under it. A plain `<s-image src="...">` tag load can't carry that
 * auth (there's no way to attach an Authorization header to a
 * browser-initiated image fetch), so this route can't authenticate the
 * request that way and must not sit behind that layout. Instead, the
 * URL's `sig`/`expires` query params ARE the authorization — they can
 * only have been produced by `getSignedUrl`, which is only ever called
 * from server code that already loaded the owning
 * `ProcessingResult`/`GenerationResult` row through a shop-scoped,
 * `assertShopOwnership`-checked repository function. There is no separate
 * ownership check here because the signature itself already proves that
 * check already happened.
 *
 * A wrong/missing/expired signature and a genuinely missing object both
 * return the same generic 404 — never distinguishable, matching this
 * codebase's established "existence oracle" prevention pattern.
 */
import type { LoaderFunctionArgs } from "react-router";
import { getConfiguredStorageProvider } from "../../lib/storage";
import { verifyMediaUrlSignature } from "../../lib/storage/local-filesystem-provider.server";
import { logger } from "../../lib/logging/logger.server";

const NOT_FOUND = () => new Response("Not found", { status: 404 });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const key = params["*"];
  if (!key) throw NOT_FOUND();

  const url = new URL(request.url);
  const valid = verifyMediaUrlSignature(key, url.searchParams.get("expires"), url.searchParams.get("sig"));
  if (!valid) {
    // Never log the signature/query string itself (see CLAUDE.md "Safe
    // error handling" / this phase's "Do not log signed URLs").
    logger.warn("media.invalid_or_expired_signature", { key });
    throw NOT_FOUND();
  }

  try {
    const object = await getConfiguredStorageProvider().download(key);
    return new Response(object.body as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": object.contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    throw NOT_FOUND();
  }
};
