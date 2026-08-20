import { describe, expect, it } from "vitest";
import { extractProductGid } from "../../../services/products/webhook-payload";

describe("extractProductGid", () => {
  it("prefers admin_graphql_api_id when present and well-formed", () => {
    expect(
      extractProductGid({ admin_graphql_api_id: "gid://shopify/Product/123", id: 456 }),
    ).toBe("gid://shopify/Product/123");
  });

  it("ignores a malformed admin_graphql_api_id and falls back to the numeric id", () => {
    expect(extractProductGid({ admin_graphql_api_id: "not-a-gid", id: 123 })).toBe(
      "gid://shopify/Product/123",
    );
  });

  it("builds a GID from a numeric id when admin_graphql_api_id is absent", () => {
    expect(extractProductGid({ id: 789 })).toBe("gid://shopify/Product/789");
  });

  it("builds a GID from a numeric-string id", () => {
    expect(extractProductGid({ id: "789" })).toBe("gid://shopify/Product/789");
  });

  it("returns null when no usable id is present", () => {
    expect(extractProductGid({})).toBeNull();
    expect(extractProductGid({ id: "not-a-number" })).toBeNull();
  });
});
