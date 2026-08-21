/**
 * Production `ImageProcessingProvider` — the first REAL (non-Unconfigured,
 * non-test) provider implementation in this codebase.
 *
 * `removeBackground` calls remove.bg (https://www.remove.bg/api) — chosen
 * as "the smallest reliable provider integration required for Phase 4"
 * (see docs/image-processing.md "Provider selection"): one REST endpoint,
 * API-key auth, does exactly one thing, no SDK to install — a plain
 * `fetch()` call is enough.
 *
 * `enhance`/`resize` run entirely LOCALLY via `sharp` — sharpening,
 * lighting correction, and aspect-ratio cropping are deterministic image
 * operations, not AI, so no vendor call is needed or appropriate; see
 * docs/image-processing.md "Provider selection" for why this is a
 * deliberate choice, not an oversight.
 *
 * `upscale`/`generateShadow`/`crop` remain unimplemented (throw
 * `UnconfiguredAIProviderError`) — not required by the Phase 4 checklist;
 * see docs/image-processing.md "Known limitations".
 *
 * Never called from a test — see services/processing/provider.server.ts's
 * double-gate. `REMOVE_BG_API_KEY` is read only via
 * lib/validation/env.server.ts, never hardcoded, never logged (see
 * SECRET_ENV_KEYS).
 *
 * Both network calls below (fetching a source image, calling remove.bg)
 * carry a bounded request timeout via `AbortController` — without one, a
 * hung upstream (dead CDN, a stalled vendor response) would hang the
 * BullMQ job indefinitely rather than failing and letting the queue's own
 * `attempts: 3` retry (lib/queue/queue.server.ts) do its job. A timeout
 * is reported as `ProviderTimeoutError`, still mapped to the same generic
 * merchant-facing failure message by services/processing/job.server.ts
 * (see CLAUDE.md "Safe error handling") — this is purely about not
 * hanging, not about a different user-facing outcome.
 */
import sharp from "sharp";
import { getEnv } from "../../lib/validation/env.server";
import { UnconfiguredAIProviderError } from "./unconfigured-provider";
import type { ImageProcessingInput, ImageProcessingOutput, ImageProcessingProvider } from "./types";

const REMOVE_BG_ENDPOINT = "https://api.remove.bg/v1.0/removebg";

/** Applied to every outbound network call this provider makes — generous
 * enough for a large source image / a vendor under normal load, short
 * enough that a hung request fails within one HTTP request cycle rather
 * than blocking a worker slot indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000;

/** A provider-specific error distinct from a generic network/HTTP
 * failure — see this module's doc comment. */
export class ProviderTimeoutError extends Error {
  constructor(what: string) {
    super(`Timed out after ${REQUEST_TIMEOUT_MS}ms: ${what}`);
    this.name = "ProviderTimeoutError";
  }
}

/** `fetch` with a bounded timeout — an aborted request surfaces as
 * `ProviderTimeoutError`, never a raw `AbortError` (which is easy to
 * mistake for a merchant-initiated cancellation). */
async function fetchWithTimeout(url: string, what: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderTimeoutError(what);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Mild, conservative defaults — "do not over-process the product" (see
 * docs/image-processing.md "Image cleanup"). */
const ENHANCE_SHARPEN_SIGMA = 0.8;

/** Fixed dimensions per aspect-ratio preset — deterministic, reusable
 * across ecommerce channels rather than hardcoded to one platform's exact
 * pixel spec (see docs/image-processing.md "Aspect ratio / channel
 * outputs"). Capped at a reasonable max dimension, not the source's full
 * resolution, to keep processing fast and outputs a predictable size. */
const ASPECT_RATIO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 2048, height: 2048 },
  "4:5": { width: 1638, height: 2048 },
  "16:9": { width: 2048, height: 1152 },
};

async function fetchSourceBytes(url: string): Promise<Buffer> {
  const response = await fetchWithTimeout(url, "fetching source image");
  if (!response.ok) {
    throw new Error(`Failed to fetch source image (status ${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export class ProductionImageProcessingProvider implements ImageProcessingProvider {
  readonly name = "production";

  async removeBackground(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    const env = getEnv();
    if (!env.REMOVE_BG_API_KEY) {
      throw new UnconfiguredAIProviderError("removeBackground");
    }

    const body = new URLSearchParams({ image_url: input.sourceImage.url, size: "auto", format: "png" });
    const response = await fetchWithTimeout(REMOVE_BG_ENDPOINT, "calling remove.bg", {
      method: "POST",
      headers: { "X-Api-Key": env.REMOVE_BG_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!response.ok) {
      // Never leak the raw vendor response body to a merchant — see
      // CLAUDE.md "Safe error handling"; services/processing/job.server.ts
      // maps any thrown error here to one fixed, generic message.
      throw new Error(`remove.bg request failed with status ${response.status}`);
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const metadata = await sharp(Buffer.from(data)).metadata();

    return {
      data,
      contentType: "image/png",
      width: metadata.width,
      height: metadata.height,
      metadata: { provider: "remove-bg" },
    };
  }

  async enhance(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    const source = await fetchSourceBytes(input.sourceImage.url);
    const { data, info } = await sharp(source)
      .normalize() // mild lighting/contrast correction
      .sharpen({ sigma: ENHANCE_SHARPEN_SIGMA }) // gentle, not aggressive
      .png()
      .toBuffer({ resolveWithObject: true });

    return {
      data: new Uint8Array(data),
      contentType: "image/png",
      width: info.width,
      height: info.height,
      metadata: { provider: "sharp-local", operation: "enhance" },
    };
  }

  async resize(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    const requestedRatio = (input.options as { aspectRatio?: string } | undefined)?.aspectRatio;
    const preset = (requestedRatio && ASPECT_RATIO_DIMENSIONS[requestedRatio]) || ASPECT_RATIO_DIMENSIONS["1:1"];

    const source = await fetchSourceBytes(input.sourceImage.url);
    const { data, info } = await sharp(source)
      .resize(preset.width, preset.height, { fit: "cover", position: "centre" })
      .png()
      .toBuffer({ resolveWithObject: true });

    return {
      data: new Uint8Array(data),
      contentType: "image/png",
      width: info.width,
      height: info.height,
      metadata: { provider: "sharp-local", operation: "resize", aspectRatio: requestedRatio ?? "1:1" },
    };
  }

  async upscale(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("upscale");
  }

  async generateShadow(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("generateShadow");
  }

  async crop(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    void input;
    throw new UnconfiguredAIProviderError("crop");
  }
}
