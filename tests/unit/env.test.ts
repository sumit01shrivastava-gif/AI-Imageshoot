import { describe, expect, it } from "vitest";
import { loadEnv } from "../../lib/validation/env.server";

const validEnv = {
  SHOPIFY_API_KEY: "key",
  SHOPIFY_API_SECRET: "secret",
  SHOPIFY_APP_URL: "https://example.com",
  SHOPIFY_SCOPES: "read_products",
  DATABASE_URL: "postgresql://localhost:5433/db",
};

describe("environment validation", () => {
  it("accepts a minimally valid environment and applies defaults", () => {
    const env = loadEnv(validEnv);

    expect(env.SHOPIFY_API_KEY).toBe("key");
    expect(env.NODE_ENV).toBe("development");
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
  });

  it("rejects a missing required variable", () => {
    const { SHOPIFY_API_KEY: _omit, ...rest } = validEnv;
    expect(() => loadEnv(rest)).toThrow(/SHOPIFY_API_KEY/);
  });

  it("rejects an invalid SHOPIFY_APP_URL", () => {
    expect(() => loadEnv({ ...validEnv, SHOPIFY_APP_URL: "not-a-url" })).toThrow(
      /SHOPIFY_APP_URL/,
    );
  });

  it("reports every problem at once, not just the first", () => {
    try {
      loadEnv({});
      throw new Error("expected loadEnv to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SHOPIFY_API_KEY");
      expect(message).toContain("SHOPIFY_API_SECRET");
      expect(message).toContain("DATABASE_URL");
    }
  });

  it("leaves optional AI/storage variables undefined when absent", () => {
    const env = loadEnv(validEnv);
    expect(env.AI_PROVIDER).toBeUndefined();
    expect(env.OBJECT_STORAGE_PROVIDER).toBeUndefined();
  });
});
