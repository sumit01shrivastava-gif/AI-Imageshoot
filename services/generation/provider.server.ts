/**
 * Resolves which `ImageGenerationProvider` generation jobs use.
 *
 * Four-way resolution: the deterministic test seam (double-gated,
 * test-only) takes priority; then `AI_PROVIDER=openai` selects
 * `OpenAIImageGenerationProvider` — the real, production commercial
 * vendor this deployment is configured against (see that file's doc
 * comment for the full evaluation/reasoning and docs/ai-pipeline.md
 * "Provider selection"); then any OTHER configured `AI_PROVIDER` value
 * (with a base URL/key) falls back to `ProductionImageGenerationProvider`
 * — the generic, vendor-agnostic "OpenAI-Images-API-compatible" JSON
 * contract, for a self-hosted or differently-branded endpoint that
 * speaks that shape; then `UnconfiguredImageGenerationProvider` (throws
 * a clear, safe error on every call) as the default when nothing is
 * configured. A future additional vendor is registered here the same
 * way — nothing calling `getConfiguredImageGenerationProvider()` needs
 * to change.
 */
import { getEnv } from "../../lib/validation/env.server";
import type { ImageGenerationProvider } from "../ai/types";
import { UnconfiguredImageGenerationProvider } from "../ai/unconfigured-provider";
import { ProductionImageGenerationProvider } from "../ai/production-image-generation-provider.server";
import { OpenAIImageGenerationProvider } from "../ai/openai-image-provider.server";
import { DeterministicTestImageGenerationProvider } from "./deterministic-test-provider.server";

/**
 * Test seam — see deterministic-test-provider.server.ts's doc comment.
 * Both conditions required, same double-gate pattern as
 * services/intelligence/provider.server.ts and
 * services/shopify/admin-context.server.ts's E2E auth bypass: an env value
 * alone is never enough, `NODE_ENV` must independently also be `"test"`.
 */
function isDeterministicTestProviderRequested(): boolean {
  const env = getEnv();
  return env.NODE_ENV === "test" && env.AI_PROVIDER === "deterministic-test";
}

export function getConfiguredImageGenerationProvider(): ImageGenerationProvider {
  if (isDeterministicTestProviderRequested()) {
    return new DeterministicTestImageGenerationProvider();
  }

  const env = getEnv();

  // OpenAI needs only the API key — its base URL defaults internally
  // (services/ai/openai-image-provider.server.ts), unlike the generic
  // contract below, which has no vendor-specific default to fall back to
  // and therefore requires an explicit AI_PROVIDER_BASE_URL.
  if (env.AI_PROVIDER === "openai" && env.AI_PROVIDER_API_KEY) {
    return new OpenAIImageGenerationProvider();
  }

  if (env.AI_PROVIDER && env.AI_PROVIDER !== "deterministic-test" && env.AI_PROVIDER !== "openai" && env.AI_PROVIDER_BASE_URL && env.AI_PROVIDER_API_KEY) {
    return new ProductionImageGenerationProvider();
  }

  // Not configured (missing AI_PROVIDER, or missing what the selected
  // provider requires) — never silently degrade to the test provider
  // outside NODE_ENV==="test" (see CLAUDE.md "Do not use deterministic
  // test providers in merchant-facing production flows").
  return new UnconfiguredImageGenerationProvider();
}
