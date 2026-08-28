/** OpenAI-backed, multimodal post-generation Quality Director evidence.
 *
 * Uses the official Responses API's image input and JSON-schema structured
 * output. The generation domain still owns the final deterministic verdict.
 * Source images are fetched server-side and embedded as data URLs so signed
 * storage URLs are neither persisted nor sent as URLs to the evaluator.
 */
import OpenAI from "openai";
import { getEnv } from "../../lib/validation/env.server";
import { logger } from "../../lib/logging/logger.server";
import { fetchWithTimeout, measureLatencyMs, ProviderResponseError } from "./http-provider-utils.server";
import type { VisualQualityEvaluationInput, VisualQualityEvaluationRaw, VisualQualityEvaluator } from "./types";
import { VisualQualityEvaluationRawSchema } from "../generation/quality-director";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;

/** The image-generation model must never be used as the Responses critic:
 * GPT Image models do not support structured outputs. Keep this resolver
 * deliberately independent of AI_PROVIDER_MODEL; deployments may opt into a
 * different compatible vision/structured-output model explicitly. */
export function resolveQualityEvaluationModel(env: { AI_PROVIDER_QUALITY_MODEL?: string }): string {
  return env.AI_PROVIDER_QUALITY_MODEL || DEFAULT_MODEL;
}

function dataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function loadReference(url: string, timeoutMs: number): Promise<{ data: Uint8Array; contentType: string }> {
  const response = await fetchWithTimeout(url, "loading a quality-evaluation reference image", timeoutMs);
  if (!response.ok) throw new ProviderResponseError("openai-quality", `reference image fetch returned ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) throw new ProviderResponseError("openai-quality", "reference image was not an image");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REFERENCE_BYTES) throw new ProviderResponseError("openai-quality", "reference image exceeded evaluation size limit");
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length === 0 || data.length > MAX_REFERENCE_BYTES) throw new ProviderResponseError("openai-quality", "reference image was empty or exceeded evaluation size limit");
  return { data, contentType };
}

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dimensions", "criticalFailures", "observations", "correctionGuidance", "confidence"],
  properties: {
    dimensions: {
      type: "object", additionalProperties: false,
      required: ["productFidelity", "briefAdherence", "creativeConcept", "artDirection", "photographyRealism", "composition", "commercialUsefulness", "designExecution", "physicalIntegrity", "channelSuitability"],
      properties: Object.fromEntries(["productFidelity", "briefAdherence", "creativeConcept", "artDirection", "photographyRealism", "composition", "commercialUsefulness", "designExecution", "physicalIntegrity", "channelSuitability"].map((key) => [key, { type: "number", minimum: 0, maximum: 10 }])),
    },
    criticalFailures: { type: "array", items: { type: "string", enum: ["PRODUCT_MISMATCH", "BRIEF_CONTRADICTION", "PHYSICAL_INTEGRITY_FAILURE", "FORMAT_FAILURE", "INVENTED_BRANDING_OR_TEXT"] }, maxItems: 8 },
    observations: { type: "array", items: { type: "string" }, maxItems: 8 },
    correctionGuidance: { type: "array", items: { type: "string" }, maxItems: 6 },
    confidence: { type: "number", minimum: 0, maximum: 10 },
  },
} as const;

export class OpenAIVisualQualityEvaluator implements VisualQualityEvaluator {
  readonly name = "openai-vision-quality";

  async evaluate(input: VisualQualityEvaluationInput): Promise<VisualQualityEvaluationRaw> {
    const env = getEnv();
    if (!env.AI_PROVIDER_API_KEY) throw new Error("OpenAI visual quality evaluation requires AI_PROVIDER_API_KEY.");
    const timeoutMs = env.AI_PROVIDER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS;
    const model = resolveQualityEvaluationModel(env);
    const referenceImages = await Promise.all(input.references.slice(0, 3).map((reference) => {
      if (reference.data && reference.contentType) return Promise.resolve({ data: reference.data, contentType: reference.contentType });
      if (!reference.url) throw new ProviderResponseError(this.name, "reference image had no accessible bytes or URL");
      return loadReference(reference.url, timeoutMs);
    }));
    const client = new OpenAI({ apiKey: env.AI_PROVIDER_API_KEY, baseURL: env.AI_PROVIDER_BASE_URL || undefined, timeout: timeoutMs, maxRetries: 0 });
    const content = [
      { type: "input_text" as const, text: `Evaluate the generated image against this compact creative brief. Inspect pixels, not prompt compliance alone. Source reference images identify the physical product, not incidental source scenery. Return concise evidence only.\n${JSON.stringify(input.qualityBrief)}` },
      { type: "input_image" as const, image_url: dataUrl(input.generatedImage.data, input.generatedImage.contentType), detail: "high" as const },
      ...referenceImages.map((image) => ({ type: "input_image" as const, image_url: dataUrl(image.data, image.contentType), detail: "high" as const })),
    ];
    logger.info("ai_provider.quality_evaluation.request", { provider: this.name, model, referenceImageCount: referenceImages.length });
    const { result: response, latencyMs } = await measureLatencyMs(() => client.responses.create({
      model,
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: "image_quality_evaluation", strict: true, schema: RESPONSE_SCHEMA } },
      store: false,
    }));
    if (response.status !== "completed" || !response.output_text) throw new ProviderResponseError(this.name, "structured quality response was incomplete");
    let parsed: unknown;
    try { parsed = JSON.parse(response.output_text); } catch { throw new ProviderResponseError(this.name, "structured quality response was not JSON"); }
    const evaluation = VisualQualityEvaluationRawSchema.parse(parsed);
    logger.info("ai_provider.quality_evaluation.completed", { provider: this.name, model, referenceImageCount: referenceImages.length, latencyMs, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null });
    return { ...evaluation, evaluatorMetadata: { provider: this.name, model, latencyMs, inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null } };
  }
}
