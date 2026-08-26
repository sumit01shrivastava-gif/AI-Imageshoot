/**
 * Unit tests: services/creative-studio/provider.server.ts — the
 * `IntentParsingProvider` resolver. Mirrors
 * services/generation/provider.server.ts's resolver shape/tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

describe("getConfiguredIntentParser", () => {
  beforeEach(() => {
    delete process.env.AI_PROVIDER;
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    resetEnvCacheForTests();
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER;
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

  it("resolves to a FallbackIntentParser wrapping the real OpenAI provider when AI_PROVIDER=openai + AI_PROVIDER_API_KEY are set — the SAME credentials already used for image generation, no AI_PROVIDER_BASE_URL required", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();

    const { getConfiguredIntentParser, resetConfiguredIntentParserForTests } = await import(
      "../../../services/creative-studio/provider.server"
    );
    resetConfiguredIntentParserForTests();
    const provider = getConfiguredIntentParser();
    expect(provider.name).toContain("openai-llm");
    expect(provider.name).toContain("heuristic");
  });

  it("AI_PROVIDER=openai takes priority over a stray AI_PROVIDER_BASE_URL — it never falls through to the generic contract", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    process.env.AI_PROVIDER_BASE_URL = "https://example-provider.test";
    resetEnvCacheForTests();

    const { getConfiguredIntentParser, resetConfiguredIntentParserForTests } = await import(
      "../../../services/creative-studio/provider.server"
    );
    resetConfiguredIntentParserForTests();
    expect(getConfiguredIntentParser().name).toContain("openai-llm");
  });

  it("falls back to the heuristic parser when AI_PROVIDER=openai but AI_PROVIDER_API_KEY is missing", async () => {
    process.env.AI_PROVIDER = "openai";
    resetEnvCacheForTests();

    const { getConfiguredIntentParser, resetConfiguredIntentParserForTests } = await import(
      "../../../services/creative-studio/provider.server"
    );
    resetConfiguredIntentParserForTests();
    expect(getConfiguredIntentParser().name).toBe("heuristic");
  });

  it("a non-openai AI_PROVIDER value still resolves the generic production contract (unchanged behavior)", async () => {
    process.env.AI_PROVIDER = "self-hosted-vendor";
    process.env.AI_PROVIDER_BASE_URL = "https://example-provider.test";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();

    const { getConfiguredIntentParser, resetConfiguredIntentParserForTests } = await import(
      "../../../services/creative-studio/provider.server"
    );
    resetConfiguredIntentParserForTests();
    expect(getConfiguredIntentParser().name).toContain("production-llm");
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
