/**
 * Production `IntentParsingProvider` — calls a real, configured LLM
 * endpoint to interpret a merchant's conversational message into
 * structured intent, rather than the rule-based
 * `HeuristicIntentParser` (services/ai/heuristic-intent-parser.ts).
 *
 * Same "no vendor SDK installed, a documented JSON contract instead"
 * approach as `production-image-generation-provider.server.ts`: no LLM
 * vendor is named/selected anywhere in this codebase, so this speaks a
 * small, explicit contract this app defines — `POST {baseUrl}/v1/intent/parse`
 * with `{ message, creativeContext, candidateResultCount }` in, the exact
 * `ParsedIntentRawOutput` shape (services/ai/types.ts) out as JSON. A
 * merchant pointing `AI_PROVIDER_BASE_URL` at any endpoint implementing
 * this contract (e.g. a thin proxy in front of a real chat-completions
 * model that's been prompted to emit this JSON shape) gets a genuinely
 * working real-LLM intent parser today; a vendor with a materially
 * different wire shape needs its own adapter file behind the same
 * interface (mirrors docs/ai-pipeline.md's existing framing for image
 * generation).
 *
 * Reuses `AI_PROVIDER_BASE_URL`/`AI_PROVIDER_API_KEY`/`AI_PROVIDER_MODEL`
 * — intent parsing is a capability of the SAME configured AI provider,
 * not a second vendor with its own credentials. Never sends the raw
 * conversation history — only the already-derived `creativeContext`
 * structure (see services/creative-studio/creative-context.ts) and the
 * single new message, matching Part 3's "do not send the entire raw
 * conversation blindly to the image model" rule (the same discipline
 * applies to the intent model).
 *
 * Output is NOT validated here — `parseParsedIntent`
 * (services/creative-studio/intent-schema.ts) is the single place
 * untrusted provider output is validated, same as every other provider
 * boundary in this codebase (CLAUDE.md "Reject malformed provider
 * output"). This class only makes the call and returns the parsed JSON
 * body as-is.
 */
import { getEnv } from "../../lib/validation/env.server";
import { logger } from "../../lib/logging/logger.server";
import { fetchWithTimeout, measureLatencyMs, ProviderRequestError, ProviderResponseError } from "./http-provider-utils.server";
import type { IntentParsingProvider, ParseIntentInput, ParsedIntentRawOutput } from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export class ProductionIntentParsingProvider implements IntentParsingProvider {
  readonly name = "production-llm";

  async parseIntent(input: ParseIntentInput): Promise<ParsedIntentRawOutput> {
    const env = getEnv();
    if (!env.AI_PROVIDER_BASE_URL || !env.AI_PROVIDER_API_KEY) {
      throw new Error("ProductionIntentParsingProvider requires AI_PROVIDER_BASE_URL and AI_PROVIDER_API_KEY.");
    }

    const timeoutMs = env.AI_PROVIDER_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS;

    logger.info("ai_provider.intent_parse.request", { provider: this.name });

    const { result: response, latencyMs } = await measureLatencyMs(() =>
      fetchWithTimeout(`${env.AI_PROVIDER_BASE_URL}/v1/intent/parse`, "calling the intent parsing provider", timeoutMs, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AI_PROVIDER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.AI_PROVIDER_MODEL || "default",
          message: input.message,
          creativeContext: input.creativeContext,
          candidateResultCount: input.candidateResultCount,
        }),
      }),
    );

    if (!response.ok) {
      logger.error("ai_provider.intent_parse.request_failed", { provider: this.name, status: response.status });
      throw new ProviderRequestError(this.name, response.status);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ProviderResponseError(this.name, "response body was not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new ProviderResponseError(this.name, "response was not a JSON object");
    }

    logger.info("ai_provider.intent_parse.completed", { provider: this.name, latencyMs });

    return parsed as ParsedIntentRawOutput;
  }
}

/**
 * Wraps a primary parser with a graceful fallback to a secondary one on
 * ANY failure (network, timeout, non-2xx, malformed JSON, or malformed
 * structured output that fails `parseParsedIntent`'s validation
 * upstream) — the Creative Studio's whole conversational feature must
 * stay usable even when a configured real-LLM provider is down or
 * misbehaving; the heuristic parser is a genuinely useful, always-correct
 * -shape default, not a degraded experience worth blocking the merchant
 * over. Logs a warning on fallback so a persistently-failing real
 * provider is observable, never silently masked forever.
 */
export class FallbackIntentParser implements IntentParsingProvider {
  readonly name: string;

  constructor(
    private readonly primary: IntentParsingProvider,
    private readonly fallback: IntentParsingProvider,
  ) {
    this.name = `${primary.name}+fallback:${fallback.name}`;
  }

  async parseIntent(input: ParseIntentInput): Promise<ParsedIntentRawOutput> {
    try {
      return await this.primary.parseIntent(input);
    } catch (error) {
      logger.warn("ai_provider.intent_parse.fallback_to_heuristic", {
        primary: this.primary.name,
        detail: error instanceof Error ? error.message : "unknown error",
      });
      return this.fallback.parseIntent(input);
    }
  }
}
