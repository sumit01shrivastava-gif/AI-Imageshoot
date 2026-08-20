/**
 * Small, shared wrapper around `admin.graphql(...)` calls.
 *
 * Every Admin GraphQL call in the app (request-scoped, via
 * `requireAdminContext`, or from the offline/background client via
 * `unauthenticated.admin`) should go through `executeAdminGraphQL` rather
 * than calling `.json()` on the raw response directly. Centralizing this
 * here means:
 *
 *   - GraphQL-level errors (`errors: [...]` in the response body) surface as
 *     a typed `ShopifyGraphQLError` instead of being silently ignored.
 *   - Throttled requests (Shopify's cost-based rate limiting) are retried
 *     with a bounded backoff instead of failing the whole operation.
 *   - Malformed/non-JSON responses and network failures are caught and
 *     turned into the same typed error, so callers (routes, sync jobs) can
 *     handle "Shopify API failure" once, generically — see CLAUDE.md
 *     "Error handling".
 *
 * This module only wraps the *transport* concern (GraphQL request/response
 * handling for whichever admin client the caller already has). It does not
 * itself decide which client to use — see `admin-context.server.ts` for
 * request-scoped auth and `client.server.ts`'s `unauthenticated` for
 * background/offline access.
 */
import { logger } from "../../lib/logging/logger.server";

/** Minimal shape both the online (`authenticate.admin`) and offline
 * (`unauthenticated.admin`) clients satisfy — all we need to run a query. */
export interface AdminGraphQLClient {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<Response>;
}

export class ShopifyGraphQLError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = "ShopifyGraphQLError";
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      // Node/TS support `cause`, but keep this defensive for older targets.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

interface GraphQLErrorEntry {
  message?: string;
  extensions?: { code?: string };
}

interface GraphQLResponseBody<T> {
  data?: T;
  errors?: GraphQLErrorEntry[];
}

const MAX_ATTEMPTS = 3;
const THROTTLE_BACKOFF_MS = [500, 1500];

function isThrottled(errors: GraphQLErrorEntry[] | undefined): boolean {
  return (errors ?? []).some((error) => error.extensions?.code === "THROTTLED");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one Admin GraphQL request and returns its `data`. Retries once or
 * twice, with a short backoff, on Shopify's THROTTLED error code; any other
 * GraphQL error, non-2xx response, or malformed body throws
 * `ShopifyGraphQLError` immediately.
 */
export async function executeAdminGraphQL<T>(
  client: AdminGraphQLClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await client.graphql(query, variables ? { variables } : undefined);
    } catch (error) {
      // Network failure / timeout. Not retried here — the caller's own
      // retry (e.g. a queue job's retry policy) is the right layer for
      // transport-level failures, so we fail fast with a clear error.
      throw new ShopifyGraphQLError("Failed to reach Shopify — network error or timeout.", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ShopifyGraphQLError(
        `Shopify Admin API responded with HTTP ${response.status}.`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }

    let body: GraphQLResponseBody<T>;
    try {
      body = (await response.json()) as GraphQLResponseBody<T>;
    } catch (error) {
      throw new ShopifyGraphQLError("Shopify Admin API returned a malformed response.", {
        cause: error,
      });
    }

    if (body.errors && body.errors.length > 0) {
      if (isThrottled(body.errors) && attempt < MAX_ATTEMPTS) {
        const backoff = THROTTLE_BACKOFF_MS[attempt - 1] ?? THROTTLE_BACKOFF_MS.at(-1)!;
        logger.warn("shopify.graphql.throttled", { attempt, backoffMs: backoff });
        lastError = body.errors;
        await sleep(backoff);
        continue;
      }

      throw new ShopifyGraphQLError(
        body.errors.map((error) => error.message).filter(Boolean).join("; ") ||
          "Shopify Admin API returned an error.",
        { retryable: isThrottled(body.errors) },
      );
    }

    if (body.data === undefined) {
      throw new ShopifyGraphQLError("Shopify Admin API response had no data.");
    }

    return body.data;
  }

  throw new ShopifyGraphQLError("Shopify Admin API request was throttled repeatedly.", {
    cause: lastError,
    retryable: true,
  });
}
