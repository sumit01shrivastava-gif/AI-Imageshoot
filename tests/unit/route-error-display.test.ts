import { describe, expect, it } from "vitest";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";
import { describeRouteError } from "../../app/route-error-display";
import { TenantMismatchError } from "../../lib/auth/tenant.server";

describe("describeRouteError", () => {
  it("reflects our own thrown-Response text for a 404 (e.g. product not found / tenant mismatch)", () => {
    const error = new ErrorResponseImpl(404, "Not Found", "Product not found");

    const result = describeRouteError(error);

    expect(result).toEqual({ heading: "Not found", message: "Product not found" });
  });

  it("never distinguishes a tenant-mismatch 404 from any other 404 — both use the exact same safe response shape", () => {
    // app/routes/app.products.$id.tsx converts TenantMismatchError into
    // `new Response("Product not found", { status: 404 })` — the SAME
    // Response the genuine not-found case throws. By the time either
    // reaches this function they are indistinguishable, which is the
    // point (no existence oracle).
    const notFound = describeRouteError(new ErrorResponseImpl(404, "Not Found", "Product not found"));
    const tenantMismatch = describeRouteError(new ErrorResponseImpl(404, "Not Found", "Product not found"));

    expect(tenantMismatch).toEqual(notFound);
  });

  it("falls back to a generic message for a Response with no/empty data", () => {
    const error = new ErrorResponseImpl(500, "Internal Server Error", undefined);

    const result = describeRouteError(error);

    expect(result.heading).toBe("Error 500");
    expect(result.message).toBe("Please go back and try again.");
  });

  it("shows a generic message for an unexpected non-Response error, and NEVER the error's own message or stack", () => {
    const error = new Error("column \"foo\" does not exist — /Users/me/app/db/client.server.ts:42");

    const result = describeRouteError(error);

    expect(result).toEqual({
      heading: "Something went wrong",
      message: "Please try again. If the problem continues, contact support.",
    });
    expect(result.message).not.toContain("column");
    expect(result.message).not.toContain(".ts:42");
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it("shows the same generic message for a TenantMismatchError that reaches here uncaught (defense in depth)", () => {
    const error = new TenantMismatchError("shop-a.myshopify.com");

    const result = describeRouteError(error);

    expect(result.heading).toBe("Something went wrong");
    expect(result.message).not.toContain("shop-a.myshopify.com");
    expect(result.message).not.toContain("does not belong");
  });

  it("shows a generic message for a non-Error thrown value", () => {
    const result = describeRouteError("a raw string throw");
    expect(result).toEqual({
      heading: "Something went wrong",
      message: "Please try again. If the problem continues, contact support.",
    });
  });
});
