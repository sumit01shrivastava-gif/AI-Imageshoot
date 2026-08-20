/**
 * Resolves which `ImageProcessingProvider` processing jobs use.
 *
 * Mirrors services/generation/provider.server.ts's shape, with one
 * addition: unlike generation (no real provider exists at all yet),
 * Phase 4 DOES have a real one — `ProductionImageProcessingProvider`
 * (services/ai/production-image-processing-provider.server.ts). It's
 * selected whenever `IMAGE_PROCESSING_PROVIDER` is set to anything other
 * than the test seam's own value — its own methods individually fall back
 * to `UnconfiguredAIProviderError` for whichever operation isn't actually
 * configured/implemented (e.g. `removeBackground` without
 * `REMOVE_BG_API_KEY` set, or `upscale` unconditionally) — see that file.
 */
import { getEnv } from "../../lib/validation/env.server";
import type { ImageProcessingProvider } from "../ai/types";
import { UnconfiguredImageProcessingProvider } from "../ai/unconfigured-provider";
import { ProductionImageProcessingProvider } from "../ai/production-image-processing-provider.server";
import { DeterministicTestImageProcessingProvider } from "./deterministic-test-provider.server";

/**
 * Test seam — see deterministic-test-provider.server.ts's doc comment.
 * Both conditions required, same double-gate pattern as every other
 * provider resolver in this codebase: an env value alone is never enough,
 * `NODE_ENV` must independently also be `"test"`.
 */
function isDeterministicTestProviderRequested(): boolean {
  const env = getEnv();
  return env.NODE_ENV === "test" && env.IMAGE_PROCESSING_PROVIDER === "deterministic-test";
}

export function getConfiguredImageProcessingProvider(): ImageProcessingProvider {
  if (isDeterministicTestProviderRequested()) {
    return new DeterministicTestImageProcessingProvider();
  }

  const env = getEnv();
  if (env.IMAGE_PROCESSING_PROVIDER && env.IMAGE_PROCESSING_PROVIDER !== "deterministic-test") {
    return new ProductionImageProcessingProvider();
  }

  // Not configured at all.
  return new UnconfiguredImageProcessingProvider();
}
