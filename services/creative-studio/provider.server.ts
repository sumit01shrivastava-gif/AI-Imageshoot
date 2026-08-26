/**
 * Resolves which `IntentParsingProvider` the Creative Studio uses.
 *
 * Three-way resolution, mirroring
 * services/generation/provider.server.ts's exact resolver shape
 * (deterministic-test seam aside, which intent parsing has no
 * equivalent of — the heuristic parser already IS a real, deterministic,
 * always-on default, not a test-only stub):
 *
 *   1. `AI_PROVIDER=openai` (+ `AI_PROVIDER_API_KEY`) selects
 *      `OpenAIIntentParsingProvider` (services/ai/openai-intent-parser.server.ts)
 *      — the SAME credentials this deployment already uses for real
 *      image generation, now also driving a real, LLM-backed creative
 *      -director reasoning stage. This is the fix for a real gap the
 *      Phase-1 audit of this pass found: the OTHER provider below
 *      speaks a custom, app-defined `/v1/intent/parse` contract that no
 *      OpenAI account can ever satisfy, so `AI_PROVIDER=openai` alone
 *      used to leave intent parsing permanently on the heuristic path
 *      no matter what was configured for image generation.
 *   2. Otherwise, `AI_PROVIDER_BASE_URL` + `AI_PROVIDER_API_KEY` alone
 *      (regardless of `AI_PROVIDER`'s value, or even if it's unset — the
 *      original, unchanged behavior) selects the generic
 *      `ProductionIntentParsingProvider` (services/ai/production-intent-parser.server.ts)
 *      — for a self-hosted/other endpoint that speaks that documented
 *      JSON contract.
 *   3. `HeuristicIntentParser` (the real, always-on rule-based default)
 *      otherwise.
 *
 * Either real-LLM branch is wrapped in a `FallbackIntentParser` that
 * falls back to the heuristic parser on any failure — the conversational
 * feature must stay usable even if the configured real-LLM endpoint is
 * down. Tests never set these env vars, so they always exercise the
 * deterministic heuristic parser — see CLAUDE.md "Never make a real AI
 * API call from a test".
 */
import { getEnv } from "../../lib/validation/env.server";
import type { IntentParsingProvider } from "../ai/types";
import { HeuristicIntentParser } from "../ai/heuristic-intent-parser";
import { ProductionIntentParsingProvider, FallbackIntentParser } from "../ai/production-intent-parser.server";
import { OpenAIIntentParsingProvider } from "../ai/openai-intent-parser.server";

let cached: IntentParsingProvider | undefined;

export function getConfiguredIntentParser(): IntentParsingProvider {
  if (!cached) {
    const env = getEnv();
    const heuristic = new HeuristicIntentParser();
    if (env.AI_PROVIDER === "openai" && env.AI_PROVIDER_API_KEY) {
      cached = new FallbackIntentParser(new OpenAIIntentParsingProvider(), heuristic);
    } else if (env.AI_PROVIDER_BASE_URL && env.AI_PROVIDER_API_KEY) {
      // Unchanged, pre-existing behavior for every other configuration
      // (including when AI_PROVIDER itself is unset) — only the
      // AI_PROVIDER==="openai" branch above is new.
      cached = new FallbackIntentParser(new ProductionIntentParsingProvider(), heuristic);
    } else {
      cached = heuristic;
    }
  }
  return cached;
}

/** Test-only: forces a fresh instance so an env override
 * (AI_PROVIDER_BASE_URL/AI_PROVIDER_API_KEY) is actually picked up. */
export function resetConfiguredIntentParserForTests(): void {
  cached = undefined;
}

/**
 * Test-only: injects a spy/fake `IntentParsingProvider` in place of the
 * resolved default. The heuristic parser deliberately IGNORES
 * `ParseIntentInput.referenceImageUrls` (see its own doc comment), so it
 * cannot be used to prove that `session.server.ts` actually threads
 * reference image URLs into the parser call — this override exists
 * specifically so integration tests can assert on the real
 * `ParseIntentInput` a call site builds, without making a real network
 * call (mirrors `setConfiguredCreativeProfileStoreForTests`/
 * `setConfiguredStorageProviderForTests`'s exact pattern).
 */
export function setConfiguredIntentParserForTests(override: IntentParsingProvider): void {
  cached = override;
}
