import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { logger } from "../lib/logging/logger.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          logger.error("request.render_error", {
            url: request.url,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}

/**
 * Server-only error reporting hook — React Router calls this for every
 * loader/action error, regardless of whether a route's `ErrorBoundary`
 * catches it and renders a fallback (see app/root.tsx's `ErrorBoundary`,
 * which deliberately never renders `error.message`/stack — this is where
 * that detail goes instead, safely, server-side only). See CLAUDE.md "No
 * sensitive values in logs" — `logger` redacts secret-shaped values, but
 * error messages/stacks aren't secrets and are exactly what's useful here.
 */
export function handleError(
  error: unknown,
  { request }: { request: Request },
): void {
  // The client navigated away / aborted the request — not an error worth logging.
  if (request.signal.aborted) return;

  // Our own (and Shopify's) intentional `throw new Response(...)` control
  // flow (404s, auth redirects, ...) isn't a bug — only log genuinely
  // unexpected errors here.
  if (error instanceof Response) return;

  logger.error("request.unhandled_error", {
    url: request.url,
    method: request.method,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
