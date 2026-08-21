/**
 * Resolves which `IntentParsingProvider` the Creative Studio uses.
 *
 * Currently always `HeuristicIntentParser` — see that file's doc comment
 * for why it's a real, always-on default rather than gated to tests the
 * way every other provider in this codebase's deterministic-test seam
 * is. Kept as its own resolver function (not inlined at each call site)
 * so a future real NLU vendor slots in here later behind the same
 * `IntentParsingProvider` interface — mirroring
 * services/generation/provider.server.ts's exact shape — with zero
 * call-site changes across services/creative-studio/.
 */
import type { IntentParsingProvider } from "../ai/types";
import { HeuristicIntentParser } from "../ai/heuristic-intent-parser";

let cached: IntentParsingProvider | undefined;

export function getConfiguredIntentParser(): IntentParsingProvider {
  if (!cached) cached = new HeuristicIntentParser();
  return cached;
}

/** Test-only: forces a fresh instance. The heuristic parser is stateless
 * (nothing to actually reset), kept purely for symmetry with every other
 * domain's provider.server.ts test-reset helper. */
export function resetConfiguredIntentParserForTests(): void {
  cached = undefined;
}
