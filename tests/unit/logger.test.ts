import { describe, expect, it } from "vitest";
import { redact } from "../../lib/logging/logger.server";

describe("log redaction", () => {
  it("redacts keys that look like secrets", () => {
    const result = redact({
      shop: "my-shop.myshopify.com",
      SHOPIFY_API_SECRET: "super-secret-value",
      accessToken: "shpat_abc123",
      password: "hunter2",
      apiKey: "key_value",
    }) as Record<string, unknown>;

    expect(result.shop).toBe("my-shop.myshopify.com");
    expect(result.SHOPIFY_API_SECRET).toBe("[REDACTED]");
    expect(result.accessToken).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("redacts secret-shaped keys nested inside objects and arrays", () => {
    const result = redact({
      session: { shop: "a.myshopify.com", refreshToken: "rt_123" },
      sessions: [{ accessToken: "shpat_1" }, { accessToken: "shpat_2" }],
    }) as Record<string, unknown>;

    expect((result.session as Record<string, unknown>).refreshToken).toBe("[REDACTED]");
    const sessions = result.sessions as Record<string, unknown>[];
    expect(sessions[0].accessToken).toBe("[REDACTED]");
    expect(sessions[1].accessToken).toBe("[REDACTED]");
  });

  it("leaves ordinary values untouched", () => {
    const result = redact({ count: 3, title: "Premium Leather Bag" }) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ count: 3, title: "Premium Leather Bag" });
  });
});
