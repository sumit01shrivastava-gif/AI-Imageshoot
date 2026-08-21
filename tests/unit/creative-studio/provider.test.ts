/**
 * Unit tests: services/creative-studio/provider.server.ts — the
 * `IntentParsingProvider` resolver. Mirrors
 * services/generation/provider.server.ts's resolver shape/tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

describe("getConfiguredIntentParser", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    resetEnvCacheForTests();
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    resetEnvCacheForTests();
  });

  it("resolves to the heuristic parser when no real provider is configured", async () => {
    const { getConfiguredIntentParser, resetConfiguredIntentParserForTests } = await import(
      "../../../services/creative-studio/provider.server"
    );
    resetConfiguredIntentParserForTests();
    expect(getConfiguredIntentParser().name).toBe("heuristic");
  });

  it("resolves to a FallbackIntentParser wrapping the production provider when AI_PROVIDER_BASE_URL/API_KEY are set", async () => {
    process.env.AI_PROVIDER_BASE_URL = "https://example-provider.test";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();

    const { getConfiguredIntentParser, resetConfiguredIntentParserForTests } = await import(
      "../../../services/creative-studio/provider.server"
    );
    resetConfiguredIntentParserForTests();
    const provider = getConfiguredIntentParser();
    expect(provider.name).toContain("production-llm");
    expect(provider.name).toContain("heuristic");
  });

  it("caches the resolved provider across calls until reset", async () => {
    const { getConfiguredIntentParser, resetConfiguredIntentParserForTests } = await import(
      "../../../services/creative-studio/provider.server"
    );
    resetConfiguredIntentParserForTests();
    const first = getConfiguredIntentParser();
    const second = getConfiguredIntentParser();
    expect(first).toBe(second);
  });
});
