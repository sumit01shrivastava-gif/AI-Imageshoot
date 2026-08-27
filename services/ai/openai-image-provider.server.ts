/**
 * OpenAI `ImageGenerationProvider` — the selected real, production
 * commercial vendor for this deployment (see docs/ai-pipeline.md
 * "Provider selection" for the full evaluation/reasoning). Speaks
 * OpenAI's ACTUAL documented wire format for the `gpt-image-*` family
 * (https://developers.openai.com/api/docs/guides/image-generation —
 * `gpt-image-2` is the current default, see `DEFAULT_MODEL` below for
 * why; `gpt-image-1` is still selectable via `AI_PROVIDER_MODEL`/
 * `AI_IMAGE_GENERATION_MODEL`/`AI_IMAGE_EDIT_MODEL`), not the generic
 * "OpenAI-Images-API-compatible" JSON contract
 * `production-image-generation-provider.server.ts` speaks for a
 * self-hosted/other vendor — the two differ in real, load-bearing ways
 * (true across the whole `gpt-image-*` family, not just one version):
 *
 *   - `/v1/images/edits` is `multipart/form-data`, not JSON — reference
 *     images are uploaded as real file parts, not base64 JSON fields.
 *   - `gpt-image-*` has no `response_format` parameter at all (it always
 *     returns `b64_json`) and no `url` output option.
 *   - `gpt-image-*`'s `quality` enum is `low`/`medium`/`high`/`auto`, not
 *     DALL·E 3's `standard`/`hd`.
 *   - `gpt-image-*`'s `size` is one of exactly `1024x1024`/`1536x1024`/
 *     `1024x1536`/`auto` — not an arbitrary WxH (`gpt-image-2` also
 *     accepts larger canvases; this app deliberately keeps requesting
 *     only this curated subset — see `sizeForAspectRatio`).
 *   - `gpt-image-*`'s edit endpoint accepts MULTIPLE reference images in
 *     one request (composite/multi-reference editing) — genuinely useful
 *     for "use the second image as reference" / "keep the product but
 *     match this background" style Creative Studio instructions.
 *
 * Selected when `AI_PROVIDER=openai` (with `AI_PROVIDER_API_KEY` set) —
 * see services/generation/provider.server.ts's resolver. Reads
 * credentials only via lib/validation/env.server.ts, never hardcoded,
 * never logged (AI_PROVIDER_API_KEY is in SECRET_ENV_KEYS). Nothing
 * outside this file imports an OpenAI SDK or knows this vendor's wire
 * shape — every other module still only ever sees `ImageGenerationProvider`.
 */
import sharp from "sharp";
import { getEnv } from "../../lib/validation/env.server";
import { logger } from "../../lib/logging/logger.server";
import { fetchWithTimeout, measureLatencyMs, ProviderInputError, ProviderRequestError, ProviderResponseError } from "./http-provider-utils.server";
import { composeProviderPrompt } from "./prompt-composition";
import type { GenerateImageInput, GenerateImageResult, GeneratedImageOutput, ImageGenerationProvider } from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com";
/**
 * `gpt-image-1` (this file's original default) started returning a real,
 * reproducible `404` from `/v1/images/generations` in production — a
 * status OpenAI's own API uses for "this model doesn't exist or you
 * don't have access to it" (never a 400/403), which OpenAI's community
 * confirms is the standard signal for a model that's no longer
 * reachable for a given account/API key. Endpoint path/method are
 * unchanged and confirmed correct against OpenAI's current docs
 * (`developers.openai.com/api/docs/guides/image-generation`, whose own
 * current example uses `gpt-image-2`) — this was never a URL problem.
 * `gpt-image-2` is OpenAI's current documented default model and its
 * `quality` enum (`low`/`medium`/`high`/`auto`) and response shape
 * (base64 `data[].b64_json`) match `gpt-image-1`'s exactly, so no other
 * change in this file was needed — `AI_PROVIDER_MODEL`/
 * `AI_IMAGE_GENERATION_MODEL`/`AI_IMAGE_EDIT_MODEL` still override this
 * unchanged, for a deployment that needs a different/pinned model.
 */
const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

/** Purely descriptive today (logging only) — see the module doc comment
 * update on `resolveReferenceImageUrls` for why whether a REAL reference
 * image is actually sent no longer depends on this. */
/** `gpt-image-*`'s `/v1/images/edits` documented supported reference
 * -image formats — see `fetchReferenceBytes`'s doc comment. Keys are
 * lowercase, parameter-stripped content-types (e.g. `"image/webp"`, not
 * `"image/webp; charset=..."`). */
const EXTENSION_FOR_CONTENT_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const CONTENT_TYPE_FOR_FORMAT = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type SupportedReferenceFormat = keyof typeof CONTENT_TYPE_FOR_FORMAT;

const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;

function detectSupportedReferenceFormat(bytes: Uint8Array): SupportedReferenceFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

function extensionForFormat(format: SupportedReferenceFormat): string {
  return EXTENSION_FOR_CONTENT_TYPE[CONTENT_TYPE_FOR_FORMAT[format]];
}

interface PreparedReferenceImage {
  bytes: Uint8Array;
  contentType: (typeof CONTENT_TYPE_FOR_FORMAT)[SupportedReferenceFormat];
  extension: string;
  detectedFormat: SupportedReferenceFormat | null;
  normalized: boolean;
}

function isEditMode(mode: string | undefined): boolean {
  return mode === "IMAGE_TO_IMAGE" || mode === "IMAGE_EDIT" || mode === "VARIATION";
}

function resolveModel(env: ReturnType<typeof getEnv>, usingReferenceImages: boolean): string {
  const specific = usingReferenceImages ? env.AI_IMAGE_EDIT_MODEL : env.AI_IMAGE_GENERATION_MODEL;
  return specific || env.AI_PROVIDER_MODEL || DEFAULT_MODEL;
}

/** `gpt-image-*` only accepts three fixed canvas sizes plus `auto` (this
 * app never requests any of `gpt-image-2`'s larger canvases — see the
 * module doc comment) — no arbitrary WxH. Maps this app's curated aspect ratios
 * (services/generation/types.ts's ASPECT_RATIOS — not imported directly
 * here, per this file's "stay generic" domain boundary) onto the closest
 * one: square stays square, anything taller-than-wide goes portrait,
 * anything wider-than-tall goes landscape. An unrecognized ratio (or one
 * this app hasn't curated) falls back to `auto` — never throws.
 *
 * `maxDimensionPx` is the shop's real plan resolution ceiling
 * (`GenerateImageInput.maxResolutionPx`) — `gpt-image-*`'s two non-square
 * sizes both have a long edge of 1536px, so a plan whose ceiling is
 * BELOW that (today, only FREE — see services/billing/plans.ts) cannot
 * honor a non-square request at all; this forces the square 1024x1024
 * option (the only one that fits under a sub-1536 ceiling) rather than
 * silently generating the larger 1536px canvas and reporting success.
 * This is a real, deliberate product trade-off — "FREE plan generates
 * square only, upgrade for portrait/landscape" — not an incidental
 * side effect; see docs/billing.md "Plan limit enforcement". `null`/
 * `undefined` (no plan context — e.g. a `GenerateImageInput` built
 * outside the plan pipeline) never restricts orientation. */
export function sizeForAspectRatio(aspectRatio: string, maxDimensionPx?: number | null): "1024x1024" | "1024x1536" | "1536x1024" | "auto" {
  const match = /^(\d+):(\d+)$/.exec(aspectRatio);
  if (!match) return "auto";
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "auto";
  const allowsWideSizes = maxDimensionPx == null || maxDimensionPx >= 1536;
  if (w === h || !allowsWideSizes) return "1024x1024";
  return w > h ? "1536x1024" : "1024x1536";
}

/** This app's curated `draft`/`standard`/`high` quality tier → `gpt-image-*`'s
 * real `low`/`medium`/`high` enum (never `standard`/`hd`, DALL·E 3's
 * scheme, which `gpt-image-*` doesn't accept). */
function qualityForTier(quality: string): "low" | "medium" | "high" {
  if (quality === "draft") return "low";
  if (quality === "high") return "high";
  return "medium";
}

interface OpenAIImagesResponseItem {
  b64_json?: string;
  revised_prompt?: string;
}

interface OpenAIImagesResponse {
  created?: number;
  data?: OpenAIImagesResponseItem[];
}

function isOpenAIImagesResponse(value: unknown): value is OpenAIImagesResponse {
  return typeof value === "object" && value !== null;
}

/** Used solely to detect an invalid-API-key response so it can be
 * classified distinctly from a generic request failure in logs. */
function looksLikeAuthError(status: number): boolean {
  return status === 401;
}

/** Sanitized shape of OpenAI's error envelope — `{ error: { message,
 * type, code, param } }`. */
interface OpenAIErrorDetail {
  message?: string;
  type?: string;
  code?: string;
  param?: string;
}

/**
 * Extracts OpenAI's own error envelope for safe server-side logging (see
 * `ai_provider.generation.request_failed` below) — never surfaced to the
 * merchant/client, only to server logs, and never anything beyond these
 * four fields (OpenAI's error body never echoes the API key or request
 * headers back, so this is safe on its own; the redacting `logger` also
 * scans every logged value for any currently-configured secret's literal
 * content regardless — see lib/logging/logger.server.ts). Without this,
 * a real failure (wrong/unavailable model, invalid parameter, etc.) was
 * only ever visible as an opaque HTTP status code — exactly what made
 * the `gpt-image-1` 404 above take real investigation to pin down instead
 * of being obvious from the first failed request's logs. Returns `null`
 * on any non-JSON or unexpected body shape — never throws, since this
 * runs on the already-failing path and must not obscure the original
 * error. */
async function parseOpenAIErrorBody(response: Response): Promise<OpenAIErrorDetail | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("error" in body)) return null;
    const error = (body as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return null;
    const e = error as Record<string, unknown>;
    return {
      message: typeof e.message === "string" ? e.message : undefined,
      type: typeof e.type === "string" ? e.type : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
      param: typeof e.param === "string" ? e.param : undefined,
    };
  } catch {
    return null;
  }
}

export class OpenAIImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "openai";

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const env = getEnv();
    if (!env.AI_PROVIDER_API_KEY) {
      throw new Error("OpenAIImageGenerationProvider requires AI_PROVIDER_API_KEY.");
    }
    const baseUrl = env.AI_PROVIDER_BASE_URL || DEFAULT_BASE_URL;
    const timeoutMs = env.AI_PROVIDER_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // PRODUCT FIDELITY (quality-floor pass): a real reference/source image
    // is sent to the provider whenever one exists — never gated on
    // `mode`. `mode` only distinguishes conversational EDIT semantics
    // ("use X as the exact starting point" — a prompt-text concern,
    // handled in services/creative-studio/plan-builder.ts) from a plain
    // request; it says nothing about whether a real photo of the actual
    // product exists to ground against. Before this fix, a Shopify
    // -context Creative Studio session's FIRST turn (mode always
    // TEXT_TO_IMAGE — there's no prior conversational result yet) and
    // EVERY non-Creative-Studio generation (PRODUCT_CLEANUP/LIFESTYLE/
    // MODEL_SHOOT/BANNER/CTA, which never set `mode` at all — see
    // services/generation/build-input.ts) silently generated from text
    // alone, never once sending the real product photo the merchant
    // actually uploaded/selected — the single highest-risk product
    // -fidelity gap in this pipeline. `resolveReferenceImageUrls` already
    // falls back to `sourceImages` when no explicit `referenceImages`
    // were supplied, so this one change fixes every affected call site.
    const editMode = isEditMode(input.mode);
    const referenceUrls = this.resolveReferenceImageUrls(input);
    const usingReferenceImages = referenceUrls.length > 0;
    const model = resolveModel(env, usingReferenceImages);
    const size = sizeForAspectRatio(input.aspectRatio, input.maxResolutionPx);
    const quality = qualityForTier(input.quality);

    logger.info("ai_provider.generation.request", {
      provider: this.name,
      generationType: input.generationType,
      mode: input.mode ?? "TEXT_TO_IMAGE",
      // Whether this turn is conversationally an edit — distinct from
      // `usingReferenceImages`, which is what actually decides the
      // endpoint/model below (see the product-fidelity comment above).
      conversationalEditMode: editMode,
      endpoint: usingReferenceImages ? "edits" : "generations",
      referenceImageCount: referenceUrls.length,
      outputCount: input.outputCount,
      size,
      quality,
      attempt: input.attempt,
      // Never the prompt text, reference URLs/bytes, or credentials.
    });

    let response: Response;
    let latencyMs: number;
    try {
      const measured = await measureLatencyMs(() =>
        usingReferenceImages
          ? this.callEdits(baseUrl, env.AI_PROVIDER_API_KEY!, timeoutMs, { model, input, referenceUrls, size, quality })
          : this.callGenerations(baseUrl, env.AI_PROVIDER_API_KEY!, timeoutMs, { model, input, size, quality }),
      );
      response = measured.result;
      latencyMs = measured.latencyMs;
    } catch (error) {
      logger.error("ai_provider.generation.request_failed", { provider: this.name, reason: error instanceof Error ? error.name : "unknown" });
      throw error;
    }

    if (!response.ok) {
      const errorDetail = await parseOpenAIErrorBody(response);
      logger.error("ai_provider.generation.request_failed", {
        provider: this.name,
        status: response.status,
        isAuthError: looksLikeAuthError(response.status),
        errorType: errorDetail?.type ?? null,
        errorCode: errorDetail?.code ?? null,
        errorParam: errorDetail?.param ?? null,
        errorMessage: errorDetail?.message ?? null,
      });
      throw new ProviderRequestError(this.name, response.status);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new ProviderResponseError(this.name, "response body was not valid JSON");
    }
    if (!isOpenAIImagesResponse(parsed) || !Array.isArray(parsed.data) || parsed.data.length === 0) {
      throw new ProviderResponseError(this.name, "response had no data[] entries");
    }

    const contentType = "image/png"; // gpt-image-* always returns PNG bytes.
    const outputs: GeneratedImageOutput[] = parsed.data.map((item, index): GeneratedImageOutput => {
      if (!item.b64_json) {
        throw new ProviderResponseError(this.name, "a data[] entry had no b64_json");
      }
      return {
        data: new Uint8Array(Buffer.from(item.b64_json, "base64")),
        contentType,
        providerResultId: `${model}-${Date.now()}-${index}`,
        metadata: { latencyMs, model, revisedPrompt: item.revised_prompt ?? null },
      };
    });

    logger.info("ai_provider.generation.completed", { provider: this.name, outputCount: outputs.length, latencyMs });

    return { outputs, raw: { model, created: parsed.created } };
  }

  /** Every real image this request has to ground against — explicit
   * `referenceImages` (e.g. the exact prior result a conversational
   * follow-up edits forward from) take priority; `sourceImages` (the
   * real product photos) fill in otherwise. Deliberately unconditional
   * (no `mode` gate) — see the product-fidelity comment in
   * `generateImage` above for why: whether a real photo exists to
   * ground against is independent of whether this turn is
   * conversationally "an edit." Returns `[]` only when genuinely
   * neither exists (e.g. a from-scratch text-to-image request with
   * nothing uploaded yet), which correctly falls through to
   * `/v1/images/generations`. */
  private resolveReferenceImageUrls(input: GenerateImageInput): string[] {
    if (input.referenceImages && input.referenceImages.length > 0) {
      return input.referenceImages.map((ref) => ref.url);
    }
    return input.sourceImages.map((image) => image.url);
  }

  private buildPrompt(input: GenerateImageInput): string {
    return composeProviderPrompt(input);
  }

  private async callGenerations(
    baseUrl: string,
    apiKey: string,
    timeoutMs: number,
    args: { model: string; input: GenerateImageInput; size: string; quality: string },
  ): Promise<Response> {
    return fetchWithTimeout(`${baseUrl}/v1/images/generations`, "calling OpenAI image generation", timeoutMs, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        prompt: this.buildPrompt(args.input),
        n: args.input.outputCount,
        size: args.size,
        quality: args.quality,
      }),
    });
  }

  /** `/v1/images/edits` is multipart/form-data — reference images are
   * fetched (from this app's own signed storage URLs — never a
   * merchant-supplied arbitrary URL, see build-input.ts/plan-builder.ts's
   * server-side resolution) and attached as real file parts, never
   * base64-encoded JSON. A single reference uses the field name `image`;
   * more than one uses `image[]` repeated, per OpenAI's documented
   * multi-image-input contract for `gpt-image-*` edits. */
  private async callEdits(
    baseUrl: string,
    apiKey: string,
    timeoutMs: number,
    args: { model: string; input: GenerateImageInput; referenceUrls: string[]; size: string; quality: string },
  ): Promise<Response> {
    const form = new FormData();
    form.set("model", args.model);
    form.set("prompt", this.buildPrompt(args.input));
    form.set("n", String(args.input.outputCount));
    form.set("size", args.size);
    form.set("quality", args.quality);

    const fieldName = args.referenceUrls.length === 1 ? "image" : "image[]";
    let index = 0;
    for (const url of args.referenceUrls) {
      const reference = await this.fetchReferenceImage(url, timeoutMs, index);
      // Slice exactly the image view: a Uint8Array may otherwise expose
      // unrelated bytes from a larger backing buffer as part of the Blob.
      const body = reference.bytes.buffer.slice(
        reference.bytes.byteOffset,
        reference.bytes.byteOffset + reference.bytes.byteLength,
      ) as ArrayBuffer;
      form.append(fieldName, new Blob([body], { type: reference.contentType }), `reference-${index}.${reference.extension}`);
      index += 1;
    }

    return fetchWithTimeout(`${baseUrl}/v1/images/edits`, "calling OpenAI image edit", timeoutMs, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` }, // multipart boundary is set by fetch itself — never set Content-Type manually here.
      body: form,
    });
  }

  /**
   * A real production benchmark used a WebP product image — every
   * reference this app forwards must reach OpenAI labeled as what it
   * actually is, not silently mislabeled as PNG (a real, previously
   * -latent bug: this method always declared `image/png` regardless of
   * the fetched bytes' real format, relying entirely on OpenAI's decoder
   * happening to sniff the real bytes rather than trusting the label —
   * fragile, and not guaranteed for every vendor/format combination).
   * `gpt-image-*` accepts PNG/JPEG/WebP reference images, but the storage
   * response header alone is not proof of what was fetched. In particular,
   * an expired/redirected signed URL can yield an HTML error body and a
   * generic/octet-stream response can contain a real JPEG. We validate
   * the actual bytes first, use the detected type/filename rather than a
   * misleading header, and only normalize decodeable non-standard image
   * modes/formats to sRGB PNG. This preserves already-valid source bytes
   * unchanged while preventing malformed multipart file parts from ever
   * reaching OpenAI.
   */
  private async fetchReferenceImage(url: string, timeoutMs: number, index: number): Promise<PreparedReferenceImage> {
    const response = await fetchWithTimeout(url, "fetching a reference image", timeoutMs);
    const rawContentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!response.ok) {
      logger.error("ai_provider.generation.reference_invalid", {
        provider: this.name,
        referenceIndex: index,
        fetchStatus: response.status,
        contentType: rawContentType || null,
        byteLength: 0,
        detectedFormat: null,
        extension: null,
        normalized: false,
        redirected: response.redirected,
      });
      throw new ProviderInputError(this.name, `reference image ${index + 1} could not be fetched (status ${response.status})`);
    }
    const sourceBytes = new Uint8Array(await response.arrayBuffer());
    const detectedFormat = detectSupportedReferenceFormat(sourceBytes);
    if (sourceBytes.length === 0 || sourceBytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      logger.error("ai_provider.generation.reference_invalid", {
        provider: this.name,
        referenceIndex: index,
        fetchStatus: response.status,
        contentType: rawContentType || null,
        byteLength: sourceBytes.length,
        detectedFormat,
        extension: null,
        normalized: false,
        redirected: response.redirected,
      });
      throw new ProviderInputError(this.name, `reference image ${index + 1} is ${sourceBytes.length === 0 ? "empty" : "too large"}`);
    }

    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      metadata = await sharp(Buffer.from(sourceBytes)).metadata();
    } catch {
      logger.error("ai_provider.generation.reference_invalid", {
        provider: this.name,
        referenceIndex: index,
        fetchStatus: response.status,
        contentType: rawContentType || null,
        byteLength: sourceBytes.length,
        detectedFormat,
        extension: null,
        normalized: false,
        redirected: response.redirected,
      });
      throw new ProviderInputError(this.name, `reference image ${index + 1} is not a valid image file`);
    }

    const metadataFormat = metadata.format as SupportedReferenceFormat | undefined;
    const canForwardUnchanged =
      metadataFormat !== undefined &&
      metadataFormat in CONTENT_TYPE_FOR_FORMAT &&
      detectedFormat === metadataFormat &&
      (metadata.space === undefined || metadata.space === "srgb");

    let prepared: PreparedReferenceImage;
    if (canForwardUnchanged) {
      const format = metadataFormat as SupportedReferenceFormat;
      prepared = {
        bytes: sourceBytes,
        contentType: CONTENT_TYPE_FOR_FORMAT[format],
        extension: extensionForFormat(format),
        detectedFormat,
        normalized: false,
      };
    } else {
      try {
        const normalized = await sharp(Buffer.from(sourceBytes)).rotate().toColorspace("srgb").png().toBuffer();
        prepared = {
          bytes: new Uint8Array(normalized),
          contentType: "image/png",
          extension: "png",
          detectedFormat,
          normalized: true,
        };
      } catch {
        logger.error("ai_provider.generation.reference_invalid", {
          provider: this.name,
          referenceIndex: index,
          fetchStatus: response.status,
          contentType: rawContentType || null,
          byteLength: sourceBytes.length,
          detectedFormat,
          extension: null,
          normalized: false,
          redirected: response.redirected,
        });
        throw new ProviderInputError(this.name, `reference image ${index + 1} cannot be prepared for editing`);
      }
    }

    logger.info("ai_provider.generation.reference_prepared", {
      provider: this.name,
      referenceIndex: index,
      fetchStatus: response.status,
      contentType: rawContentType || null,
      byteLength: sourceBytes.length,
      detectedFormat,
      extension: prepared.extension,
      normalized: prepared.normalized,
      redirected: response.redirected,
    });
    return prepared;
  }
}
