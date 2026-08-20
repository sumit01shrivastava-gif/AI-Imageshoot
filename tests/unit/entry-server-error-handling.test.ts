import { afterEach, describe, expect, it, vi } from "vitest";
import { handleError } from "../../app/entry.server";
import { logger } from "../../lib/logging/logger.server";

function fakeArgs(request: Request) {
  return { request, context: {}, params: {} };
}

describe("handleError (app/entry.server.tsx)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an unexpected error server-side, including the real message and stack", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const error = new Error("relation \"shopify_product\" does not exist");
    const request = new Request("https://example.com/app/products/abc123");

    handleError(error, fakeArgs(request));

    expect(spy).toHaveBeenCalledTimes(1);
    const [message, meta] = spy.mock.calls[0];
    expect(message).toBe("request.unhandled_error");
    expect(meta?.message).toContain("shopify_product");
    expect(meta?.stack).toBeDefined();
    expect(meta?.url).toBe("https://example.com/app/products/abc123");
  });

  it("does not log a thrown Response (expected control flow, e.g. a 404 or an auth redirect)", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const request = new Request("https://example.com/app/products/abc123");

    handleError(new Response("Product not found", { status: 404 }), fakeArgs(request));

    expect(spy).not.toHaveBeenCalled();
  });

  it("does not log an aborted request", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();
    const request = new Request("https://example.com/app/products/abc123", {
      signal: controller.signal,
    });

    handleError(new Error("client went away"), fakeArgs(request));

    expect(spy).not.toHaveBeenCalled();
  });

  it("handles a non-Error thrown value without crashing, still logging something useful", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const request = new Request("https://example.com/app/products/abc123");

    expect(() => handleError("a raw string throw", fakeArgs(request))).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]?.message).toBe("a raw string throw");
  });
});
