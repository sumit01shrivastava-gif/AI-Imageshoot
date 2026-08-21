/**
 * Resolves which `IntentParsingProvider` the Creative Studio uses.
 *
 * `HeuristicIntentParser` (the real, always-on rule-based default — see
 * that file's doc comment) when no real LLM provider is configured.
 * When `AI_PROVIDER_BASE_URL`/`AI_PROVIDER_API_KEY` ARE configured,
 * wraps `ProductionIntentParsingProvider`
 * (services/ai/production-intent-parser.server.ts) in a
 * `FallbackIntentParser` that falls back to the heuristic parser on any
 * failure — the conversational feature must stay usable even if the
 * configured real-LLM endpoint is down. Tests never set those env vars,
 * so they always exercise the deterministic heuristic parser — see
 * CLAUDE.md "Never make a real AI API call from a test".
 *
 * Mirrors services/generation/provider.server.ts's exact resolver shape.
 */
import { getEnv } from "../../lib/validation/env.server";
import type { IntentParsingProvider } from "../ai/types";
import { HeuristicIntentParser } from "../ai/heuristic-intent-parser";
import { ProductionIntentParsingProvider, FallbackIntentParser } from "../ai/production-intent-parser.server";

let cached: IntentParsingProvider | undefined;

export function getConfiguredIntentParser(): IntentParsingProvider {
  if (!cached) {
    const env = getEnv();
    const heuristic = new HeuristicIntentParser();
    cached =
      env.AI_PROVIDER_BASE_URL && env.AI_PROVIDER_API_KEY
        ? new FallbackIntentParser(new ProductionIntentParsingProvider(), heuristic)
        : heuristic;
  }
  return cached;
}

/** Test-only: forces a fresh instance so an env override
 * (AI_PROVIDER_BASE_URL/AI_PROVIDER_API_KEY) is actually picked up. */
export function resetConfiguredIntentParserForTests(): void {
  cached = undefined;
}
