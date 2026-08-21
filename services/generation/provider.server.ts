/**
 * Resolves which `ImageGenerationProvider` generation jobs use.
 *
 * Mirrors services/processing/provider.server.ts's exact three-way shape:
 * the deterministic test seam (double-gated, test-only) takes priority,
 * then a real, configured vendor (`ProductionImageGenerationProvider` —
 * see that file's doc comment for the contract it speaks and why), then
 * `UnconfiguredImageGenerationProvider` (throws a clear, safe error on
 * every call) as the default when nothing is configured. When a
 * differently-shaped real vendor is added later, its implementation is
 * registered here behind the same `ImageGenerationProvider` interface;
 * nothing calling `getConfiguredImageGenerationProvider()` needs to
 * change.
 */
import { getEnv } from "../../lib/validation/env.server";
import type { ImageGenerationProvider } from "../ai/types";
import { UnconfiguredImageGenerationProvider } from "../ai/unconfigured-provider";
import { ProductionImageGenerationProvider } from "../ai/production-image-generation-provider.server";
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
  if (env.AI_PROVIDER && env.AI_PROVIDER !== "deterministic-test" && env.AI_PROVIDER_BASE_URL && env.AI_PROVIDER_API_KEY) {
    return new ProductionImageGenerationProvider();
  }

  // Not configured (missing AI_PROVIDER, or missing the base URL/key the
  // production provider requires) — never silently degrade to the test
  // provider outside NODE_ENV==="test" (see CLAUDE.md "Do not use
  // deterministic test providers in merchant-facing production flows").
  return new UnconfiguredImageGenerationProvider();
}
