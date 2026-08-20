import type { ReactNode } from "react";
import { Links, Meta, Outlet, ScrollRestoration, Scripts, useRouteError } from "react-router";
import { describeRouteError } from "./route-error-display";

/**
 * Shared document shell for both the normal render (`App`, below) and the
 * root-level `ErrorBoundary` — the `Layout`/`App`/`ErrorBoundary` split is
 * React Router 7's documented root-route pattern specifically so the
 * `<html>`/`<head>` boilerplate isn't duplicated between the two.
 */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Root-level error boundary — the last line of defense for any error that
 * escapes every route-level boundary below it. In particular,
 * `app/routes/app.tsx`'s Shopify-provided `ErrorBoundary` (`boundary.error`)
 * only recognizes Shopify's own auth-redirect `Response`s and re-throws
 * anything else — without this boundary, that re-thrown error (e.g. a
 * `TenantMismatchError`) previously fell through to React Router's built-in
 * default error page, which renders the raw error message and a
 * file/line stack trace directly into the page. See the Phase 0/1 security
 * audit and CLAUDE.md "Safe error handling".
 *
 * The classification logic (what's safe to show for which kind of error)
 * lives in ./route-error-display.ts's `describeRouteError`, kept separate
 * so it's directly unit-testable without rendering React — see that
 * file's doc comment for the exact rules.
 *
 * The real error is still captured server-side regardless of whether this
 * boundary renders a fallback for it — see app/entry.server.tsx's
 * `handleError`, which React Router calls for every loader/action error.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const { heading, message } = describeRouteError(error);

  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
      <h1>{heading}</h1>
      <p>{message}</p>
    </div>
  );
}
