import { afterEach, describe, expect, it } from "vitest";
import { redact } from "../../lib/logging/logger.server";
import { resetEnvCacheForTests } from "../../lib/validation/env.server";

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

  // Key-name-based redaction alone can't catch a secret that ends up
  // embedded inside an unrelated field's string content — e.g. a vendor
  // or GraphQL error message that happens to echo a credential back (see
  // services/*/job.server.ts's `detail: error.message` logging pattern).
  // `redact` also scans string VALUES for any currently-configured
  // secret's literal value, regardless of the key they're under.
  describe("value-shape redaction (a secret embedded in an unrelated string)", () => {
    afterEach(() => {
      delete process.env.AI_PROVIDER_API_KEY;
      resetEnvCacheForTests();
    });

    it("redacts a real, currently-configured secret (tests/setup.ts's SHOPIFY_API_SECRET) found inside an innocuous-keyed string", () => {
      const result = redact({
        detail: "provider rejected credential test_api_secret during handshake",
      }) as Record<string, unknown>;
      expect(result.detail).toBe("provider rejected credential [REDACTED] during handshake");
    });

    it("redacts a secret set only for this test, picked up after resetEnvCacheForTests()", () => {
      process.env.AI_PROVIDER_API_KEY = "sk_live_abcdef123456";
      resetEnvCacheForTests();

      const result = redact({ detail: "auth failed for sk_live_abcdef123456" }) as Record<string, unknown>;
      expect(result.detail).toBe("auth failed for [REDACTED]");
    });

    it("never throws or drops the log line just because the environment fails to validate", () => {
      const originalDbUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL; // makes getEnv() throw
      resetEnvCacheForTests();

      try {
        expect(() => redact({ detail: "unaffected message" })).not.toThrow();
        expect(redact({ detail: "unaffected message" })).toEqual({ detail: "unaffected message" });
      } finally {
        process.env.DATABASE_URL = originalDbUrl;
        resetEnvCacheForTests();
      }
    });
  });
});
