/**
 * OpenAI `IntentParsingProvider` — speaks OpenAI's ACTUAL Chat Completions
 * wire format, the same way `openai-image-provider.server.ts` speaks
 * OpenAI's actual image API instead of the generic vendor-agnostic
 * contract. This is the fix for a real gap the Phase-1 audit found:
 * `ProductionIntentParsingProvider` (production-intent-parser.server.ts)
 * only ever speaks a custom, APP-DEFINED `/v1/intent/parse` contract —
 * gated on `AI_PROVIDER_BASE_URL` — which no OpenAI account can ever
 * satisfy, because OpenAI doesn't expose that endpoint. A merchant who
 * already set `AI_PROVIDER=openai` + `AI_PROVIDER_API_KEY` for real
 * image generation (openai-image-provider.server.ts) therefore had NO
 * way to also get a real LLM-backed intent parser without separately
 * standing up a custom proxy service — the "real LLM path" was
 * reachable in the code, but not with the credentials this deployment
 * actually has. This file closes that gap using the SAME credentials.
 *
 * `POST {baseUrl}/v1/chat/completions` with:
 *   - `messages`: a `system` message carrying
 *     `CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION`
 *     (creative-director-instructions.ts — the real, generalized
 *     "reason like a professional creative director" framing this whole
 *     pass exists to establish), and one `user` message whose content is
 *     an array of parts: one `text` part (the JSON-encoded `message`/
 *     `creativeContext`/`candidateResultCount`) plus one `image_url` part
 *     per `input.referenceImageUrls` entry — OpenAI's real vision-input
 *     content-part shape, letting a genuinely multimodal call reason
 *     about a reference image's identity/pose/environment instead of
 *     only a text description of it.
 *   - `response_format: { type: "json_object" }` — OpenAI's real
 *     structured-output parameter; still independently validated by
 *     `parseParsedIntent` afterward (CLAUDE.md "Reject malformed
 *     provider output" — a model asked for JSON can still return
 *     something that fails the actual schema).
 *
 * Selected when `AI_PROVIDER=openai` (with `AI_PROVIDER_API_KEY` set) —
 * mirrors `services/generation/provider.server.ts`'s exact
 * "OpenAI needs only the API key, base URL defaults internally" pattern
 * for image generation. Model resolution: `AI_PROVIDER_INTENT_MODEL`,
 * falling back to `AI_PROVIDER_MODEL`, falling back to `DEFAULT_MODEL`
 * below — the same three-tier fallback
 * `AI_IMAGE_GENERATION_MODEL`/`AI_IMAGE_EDIT_MODEL` already use.
 *
 * Never logs the merchant's raw message, the system instruction, or any
 * reference-image URL — only counts/booleans, same discipline as every
 * other provider file in this codebase.
 */
import { getEnv } from "../../lib/validation/env.server";
import { logger } from "../../lib/logging/logger.server";
import { fetchWithTimeout, measureLatencyMs, ProviderRequestError, ProviderResponseError } from "./http-provider-utils.server";
import { CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION } from "./creative-director-instructions";
import type { IntentParsingProvider, ParseIntentInput, ParsedIntentRawOutput } from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com";
/** A real, currently-available OpenAI model supporting both JSON-mode
 * structured output and vision input — a reasonable default for a
 * classification/reasoning task like this, not a generation-quality
 * concern. Override via `AI_PROVIDER_INTENT_MODEL`/`AI_PROVIDER_MODEL`
 * if the deployed account needs a specific/pinned model. */
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

function resolveModel(env: ReturnType<typeof getEnv>): string {
  return env.AI_PROVIDER_INTENT_MODEL || env.AI_PROVIDER_MODEL || DEFAULT_MODEL;
}

type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export class OpenAIIntentParsingProvider implements IntentParsingProvider {
  readonly name = "openai-llm";

  async parseIntent(input: ParseIntentInput): Promise<ParsedIntentRawOutput> {
    const env = getEnv();
    if (!env.AI_PROVIDER_API_KEY) {
      throw new Error("OpenAIIntentParsingProvider requires AI_PROVIDER_API_KEY.");
    }

    const baseUrl = env.AI_PROVIDER_BASE_URL || DEFAULT_BASE_URL;
    const timeoutMs = env.AI_PROVIDER_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const referenceImageUrls = input.referenceImageUrls ?? [];

    const userContent: ChatContentPart[] = [
      {
        type: "text",
        text: JSON.stringify({
          message: input.message,
          creativeContext: input.creativeContext,
          candidateResultCount: input.candidateResultCount,
        }),
      },
      ...referenceImageUrls.map((url): ChatContentPart => ({ type: "image_url", image_url: { url } })),
    ];

    logger.info("ai_provider.intent_parse.request", { provider: this.name, referenceImageCount: referenceImageUrls.length });

    const { result: response, latencyMs } = await measureLatencyMs(() =>
      fetchWithTimeout(`${baseUrl}/v1/chat/completions`, "calling the OpenAI intent parsing provider", timeoutMs, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AI_PROVIDER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: resolveModel(env),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION },
            { role: "user", content: userContent },
          ],
        }),
      }),
    );

    if (!response.ok) {
      logger.error("ai_provider.intent_parse.request_failed", { provider: this.name, status: response.status });
      throw new ProviderRequestError(this.name, response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderResponseError(this.name, "response body was not valid JSON");
    }

    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ProviderResponseError(this.name, "response had no chat completion content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ProviderResponseError(this.name, "chat completion content was not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProviderResponseError(this.name, "chat completion content was not a JSON object");
    }

    logger.info("ai_provider.intent_parse.completed", { provider: this.name, latencyMs });

    return parsed as ParsedIntentRawOutput;
  }
}
