/**
 * Unit tests: services/generation/provider.server.ts's
 * `getConfiguredImageGenerationProvider` resolver — the four-way
 * selection between the deterministic test provider, the real OpenAI
 * adapter, the generic vendor-agnostic contract, and the unconfigured
 * default.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

function clearProviderEnv() {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_PROVIDER_API_KEY;
  delete process.env.AI_PROVIDER_BASE_URL;
}

describe("getConfiguredImageGenerationProvider", () => {
  beforeEach(() => {
    clearProviderEnv();
    resetEnvCacheForTests();
  });
  afterEach(() => {
    clearProviderEnv();
    resetEnvCacheForTests();
  });

  it("resolves to UnconfiguredImageGenerationProvider when nothing is configured", async () => {
    const { getConfiguredImageGenerationProvider } = await import("../../../services/generation/provider.server");
    expect(getConfiguredImageGenerationProvider().name).toBe("unconfigured");
  });

  it("resolves to the real OpenAI provider when AI_PROVIDER=openai and only the API key is set (no base URL needed)", async () => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_PROVIDER_API_KEY = "sk-test";
    resetEnvCacheForTests();
    const { getConfiguredImageGenerationProvider } = await import("../../../services/generation/provider.server");
    expect(getConfiguredImageGenerationProvider().name).toBe("openai");
  });

  it("stays unconfigured for AI_PROVIDER=openai with no API key", async () => {
    process.env.AI_PROVIDER = "openai";
    resetEnvCacheForTests();
    const { getConfiguredImageGenerationProvider } = await import("../../../services/generation/provider.server");
    expect(getConfiguredImageGenerationProvider().name).toBe("unconfigured");
  });

  it("resolves to the generic production provider for any other AI_PROVIDER value with base URL + key", async () => {
    process.env.AI_PROVIDER = "self-hosted";
    process.env.AI_PROVIDER_BASE_URL = "https://my-endpoint.example.com";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();
    const { getConfiguredImageGenerationProvider } = await import("../../../services/generation/provider.server");
    expect(getConfiguredImageGenerationProvider().name).toBe("production");
  });

  it("stays unconfigured for a non-openai AI_PROVIDER with no base URL", async () => {
    process.env.AI_PROVIDER = "self-hosted";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();
    const { getConfiguredImageGenerationProvider } = await import("../../../services/generation/provider.server");
    expect(getConfiguredImageGenerationProvider().name).toBe("unconfigured");
  });
});
