import type { ReactNode } from "react";
import type { LinksFunction } from "react-router";
import { Links, Meta, Outlet, ScrollRestoration, Scripts, useRouteError } from "react-router";
import { describeRouteError } from "./route-error-display";
import globalStylesHref from "./styles/global.css?url";

/** The one global stylesheet for the app's premium presentation layer —
 * see app/styles/global.css's doc comment. Everything else stays on
 * Polaris web components' own built-in styling. */
export const links: LinksFunction = () => [{ rel: "stylesheet", href: globalStylesHref }];

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
    <div style={{ padding: "3rem 1.5rem", fontFamily: "var(--aps-font, sans-serif)", maxWidth: "28rem", margin: "0 auto", textAlign: "center" }}>
      <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>{heading}</h1>
      <p style={{ color: "var(--aps-ink-subdued, #6b6f76)", marginBottom: "1.5rem" }}>{message}</p>
      <a
        href="/app"
        style={{
          display: "inline-block",
          padding: "0.625rem 1.25rem",
          borderRadius: "999px",
          background: "var(--aps-accent, #6c47ff)",
          color: "#fff",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Back to AI Product Shoot
      </a>
    </div>
  );
}
