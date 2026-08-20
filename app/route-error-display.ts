/**
 * Pure classification for app/root.tsx's `ErrorBoundary`: given whatever
 * `useRouteError()` returned, decide what's safe to show a merchant.
 *
 * Kept in its own plain (non-JSX) module, separate from the component
 * itself, specifically so this logic — the part the Phase 0/1 security
 * audit cared about — is directly unit-testable without rendering React.
 * See app/root.tsx's `ErrorBoundary` doc comment for the full "why".
 */
import { isRouteErrorResponse } from "react-router";

export interface RouteErrorDisplay {
  heading: string;
  message: string;
}

const GENERIC_ERROR: RouteErrorDisplay = {
  heading: "Something went wrong",
  message: "Please try again. If the problem continues, contact support.",
};

/**
 * Rules, deliberately simple:
 *   - A thrown `Response` (`isRouteErrorResponse(error)` — our own
 *     `throw new Response(text, { status })` calls, e.g.
 *     app.products.$id.tsx's not-found / tenant-mismatch handling, both
 *     intentionally using this exact shape) is safe to reflect as-is:
 *     that text is always merchant-safe by construction, authored by us.
 *   - Anything else — a genuine unexpected `Error` (including a
 *     `TenantMismatchError` that somehow reached here uncaught), a
 *     rejected promise, anything not a `Response` — NEVER has its
 *     `.message` or stack surfaced here, in any environment. Only the
 *     static `GENERIC_ERROR` is returned.
 */
export function describeRouteError(error: unknown): RouteErrorDisplay {
  if (isRouteErrorResponse(error)) {
    const heading = error.status === 404 ? "Not found" : `Error ${error.status}`;
    const message =
      typeof error.data === "string" && error.data.trim().length > 0
        ? error.data
        : "Please go back and try again.";
    return { heading, message };
  }

  return GENERIC_ERROR;
}
