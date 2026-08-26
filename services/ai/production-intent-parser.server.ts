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
 * with `{ message, creativeContext, candidateResultCount, images? }` in,
 * the exact `ParsedIntentRawOutput` shape (services/ai/types.ts) out as
 * JSON. A merchant pointing `AI_PROVIDER_BASE_URL` at any endpoint
 * implementing this contract (e.g. a thin proxy in front of a real
 * chat-completions model that's been prompted to emit this JSON shape)
 * gets a genuinely working real-LLM intent parser today; a vendor with a
 * materially different wire shape needs its own adapter file behind the
 * same interface (mirrors docs/ai-pipeline.md's existing framing for
 * image generation).
 *
 * `images` (present only when `input.referenceImageUrls` is non-empty —
 * see services/ai/types.ts's `ParseIntentInput.referenceImageUrls` doc
 * comment) is what makes this a genuinely MULTIMODAL request when a
 * reference image exists for this turn: a real vision-capable endpoint
 * can now reason about identity/pose/clothing/background it can
 * actually see, not just a text description of it. This was a real,
 * previously-identified gap — this provider used to send ONLY
 * `{ message, creativeContext, candidateResultCount }`, meaning even a
 * fully-configured real LLM reasoned about a reference-image turn
 * completely blind to the image itself.
 *
 * Reuses `AI_PROVIDER_BASE_URL`/`AI_PROVIDER_API_KEY`/`AI_PROVIDER_MODEL`
 * — intent parsing is a capability of the SAME configured AI provider,
 * not a second vendor with its own credentials. Still never sends the
 * raw conversation history — only the already-derived `creativeContext`
 * structure (see services/creative-studio/creative-context.ts), the
 * single new message, and now the turn's own reference image URL(s),
 * matching Part 3's "do not send the entire raw conversation blindly to
 * the image model" rule (the same discipline applies to the intent
 * model) — more visual signal, not more text.
 *
 * Output is NOT validated here — `parseParsedIntent`
 * (services/creative-studio/intent-schema.ts) is the single place
 * untrusted provider output is validated, same as every other provider
 * boundary in this codebase (CLAUDE.md "Reject malformed provider
 * output"). This class only makes the call and returns the parsed JSON
 * body as-is.
 *
 * `systemInstruction` (the "creative director" upgrade): the request
 * body now also carries `CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION`
 * (creative-director-instructions.ts) — the actual, generalized
 * instructions for reasoning like a professional creative director
 * (explicit-vs-inferred separation, reference-image identity-vs
 * -transformation, contradiction handling), rather than assuming
 * whatever runs behind `AI_PROVIDER_BASE_URL` already has its own
 * equivalent framing baked in. Purely additive — an endpoint that
 * ignores unknown fields sees no behavior change; one that wants this
 * app's own creative-director framing now has it.
 */
import { getEnv } from "../../lib/validation/env.server";
import { logger } from "../../lib/logging/logger.server";
import { fetchWithTimeout, measureLatencyMs, ProviderRequestError, ProviderResponseError } from "./http-provider-utils.server";
import { CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION } from "./creative-director-instructions";
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

    const referenceImageUrls = input.referenceImageUrls ?? [];
    logger.info("ai_provider.intent_parse.request", { provider: this.name, referenceImageCount: referenceImageUrls.length });

    const { result: response, latencyMs } = await measureLatencyMs(() =>
      fetchWithTimeout(`${env.AI_PROVIDER_BASE_URL}/v1/intent/parse`, "calling the intent parsing provider", timeoutMs, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AI_PROVIDER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.AI_PROVIDER_MODEL || "default",
          systemInstruction: CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION,
          message: input.message,
          creativeContext: input.creativeContext,
          candidateResultCount: input.candidateResultCount,
          // Real multimodal reference-image understanding (Part C):
          // matches the field shape OpenAI's own vision-capable chat
          // input uses for an image URL part
          // (`{type: "image_url", image_url: {url}}`) — a reasonable,
          // real, vendor-agnostic choice for "a thin proxy in front of a
          // real chat-completions model" (this file's own module doc
          // comment), letting a genuinely multimodal endpoint reason
          // about identity/pose/clothing/background it can actually see
          // rather than only a text description of it. Omitted (not an
          // empty array) when there's nothing to send, so an endpoint
          // that doesn't expect this field at all sees no shape change
          // for the (common) text-only turn.
          ...(referenceImageUrls.length > 0
            ? { images: referenceImageUrls.map((url) => ({ type: "image_url", image_url: { url } })) }
            : {}),
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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
