/**
 * Deterministic, network-free `ImageProcessingProvider` — for tests only.
 *
 * Mirrors services/generation/deterministic-test-provider.server.ts: a
 * real vendor call (remove.bg) or real local processing (sharp, against a
 * real fetched image) can't run in an automated test the same predictable
 * way every time, but the processing domain's route → service → queue →
 * provider → validation → storage → persistence → UI path needs to be
 * exercised end to end.
 *
 * Only ever selected by provider.server.ts's
 * `getConfiguredImageProcessingProvider()` when `NODE_ENV === "test"` AND
 * `IMAGE_PROCESSING_PROVIDER === "deterministic-test"` — both required,
 * neither set outside test config.
 *
 * Produces a fixed, tiny, valid 1x1 PNG for every operation.
 */
import { createHash } from "node:crypto";
import type { ImageProcessingInput, ImageProcessingOutput, ImageProcessingProvider } from "../ai/types";

/** Smallest possible valid PNG (1x1, transparent) — same fixture
 * services/generation's deterministic provider uses. */
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * Forced-failure hooks for integration/E2E tests exercising the FAILED/
 * retry path — see docs/image-processing.md "Retry behavior". Checked
 * against the source image's `altText` (a plain string, nothing schema-
 * strict about it) rather than `options` (which IS strictly validated —
 * see services/processing/schema.ts's `ProcessingOptionsSchema` —
 * `.strict()`, so it can't carry an ad-hoc test-only key). Reachable only
 * by test fixtures that seed a `ShopifyProductMedia` row with this as its
 * `altText`; never something a merchant-facing flow produces.
 */
export const FORCE_FAILURE_ALWAYS = "__PROCESSING_TEST_FAIL_ALWAYS__";
export const FORCE_FAILURE_ONCE = "__PROCESSING_TEST_FAIL_ONCE__";

function deterministicId(prefix: string, parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

/** `attempt` isn't part of `ImageProcessingInput` (unlike generation's
 * `GenerateImageInput.attempt`) — the processing interface has no
 * multi-attempt-aware field, so the deterministic provider tracks it
 * itself, keyed by the source image url, for the FAIL_ONCE hook. This is
 * test-only bookkeeping; the real `ProductionImageProcessingProvider` is
 * stateless and doesn't need this (a real vendor call/local transform is
 * naturally idempotent-safe to retry). */
const attemptsSeen = new Map<string, number>();

function nextAttempt(url: string): number {
  const attempt = (attemptsSeen.get(url) ?? 0) + 1;
  attemptsSeen.set(url, attempt);
  return attempt;
}

/** Test hygiene: clears FAIL_ONCE bookkeeping between test files/cases
 * that might reuse the same source image URL. */
export function resetDeterministicProcessingProviderStateForTests(): void {
  attemptsSeen.clear();
}

function output(operation: string, input: ImageProcessingInput): ImageProcessingOutput {
  return {
    data: Buffer.from(TINY_PNG_BASE64, "base64"),
    contentType: "image/png",
    width: 1,
    height: 1,
    metadata: {
      source: "deterministic-test-provider",
      operation,
      providerResultId: deterministicId("result", [operation, input.sourceImage.mediaId]),
    },
  };
}

async function maybeFail(input: ImageProcessingInput): Promise<void> {
  const marker = input.sourceImage.altText ?? "";
  if (marker.includes(FORCE_FAILURE_ALWAYS)) {
    throw new Error("deterministic-test processing provider: forced failure (every attempt)");
  }
  if (marker.includes(FORCE_FAILURE_ONCE) && nextAttempt(input.sourceImage.url) <= 1) {
    throw new Error("deterministic-test processing provider: forced failure (attempt 1 only)");
  }
}

export class DeterministicTestImageProcessingProvider implements ImageProcessingProvider {
  readonly name = "deterministic-test";

  async removeBackground(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    await maybeFail(input);
    return output("removeBackground", input);
  }

  async enhance(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    await maybeFail(input);
    return output("enhance", input);
  }

  async resize(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    await maybeFail(input);
    return output("resize", input);
  }

  async upscale(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    await maybeFail(input);
    return output("upscale", input);
  }

  async generateShadow(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    await maybeFail(input);
    return output("generateShadow", input);
  }

  async crop(input: ImageProcessingInput): Promise<ImageProcessingOutput> {
    await maybeFail(input);
    return output("crop", input);
  }
}
