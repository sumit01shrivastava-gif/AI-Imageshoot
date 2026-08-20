/**
 * Resolves which `AIProvider` Product Intelligence analysis uses.
 *
 * No real AI vendor SDK is installed yet (see docs/ai-pipeline.md) — this
 * always returns `UnconfiguredAIProvider` outside of the narrow test seam
 * below. When a real vendor is selected, its implementation gets
 * registered here, behind the same `AIProvider` interface; nothing calling
 * `getConfiguredAIProvider()` needs to change.
 */
import { getEnv } from "../../lib/validation/env.server";
import type { AIProvider } from "../ai/types";
import { UnconfiguredAIProvider } from "../ai/unconfigured-provider";
import { DeterministicTestAIProvider } from "./deterministic-test-provider.server";

/**
 * Test seam — see deterministic-test-provider.server.ts's doc comment.
 * Both conditions are required, mirroring
 * services/shopify/admin-context.server.ts's E2E auth-bypass pattern: an
 * env value alone is never enough, `NODE_ENV` must independently also be
 * `"test"`, so this can't activate in development or production even if
 * `AI_PROVIDER` were accidentally set to this value somewhere.
 */
function isDeterministicTestProviderRequested(): boolean {
  const env = getEnv();
  return env.NODE_ENV === "test" && env.AI_PROVIDER === "deterministic-test";
}

export function getConfiguredAIProvider(): AIProvider {
  if (isDeterministicTestProviderRequested()) {
    return new DeterministicTestAIProvider();
  }

  // No real vendor selected/installed yet.
  return new UnconfiguredAIProvider();
}
