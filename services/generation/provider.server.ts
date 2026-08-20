/**
 * Resolves which `ImageGenerationProvider` generation jobs use.
 *
 * No real AI vendor SDK is installed yet (see docs/ai-pipeline.md,
 * docs/generation.md) — this always returns `UnconfiguredImageGenerationProvider`
 * outside of the narrow test seam below, exactly mirroring
 * services/intelligence/provider.server.ts's `getConfiguredAIProvider()`.
 * When a real vendor is selected, its implementation gets registered here,
 * behind the same `ImageGenerationProvider` interface; nothing calling
 * `getConfiguredImageGenerationProvider()` needs to change.
 */
import { getEnv } from "../../lib/validation/env.server";
import type { ImageGenerationProvider } from "../ai/types";
import { UnconfiguredImageGenerationProvider } from "../ai/unconfigured-provider";
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

  // No real vendor selected/installed yet.
  return new UnconfiguredImageGenerationProvider();
}
