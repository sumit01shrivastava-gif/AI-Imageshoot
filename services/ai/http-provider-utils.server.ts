/**
 * Shared HTTP-calling utilities for real (non-Unconfigured, non-test)
 * `services/ai/` provider implementations — timeout handling and
 * structured error classification, factored out of
 * production-image-processing-provider.server.ts (Phase 4's remove.bg
 * integration, the first real vendor call in this codebase) so
 * production-image-generation-provider.server.ts doesn't duplicate it.
 *
 * Nothing here is vendor-specific — every real provider file imports
 * from here, never from a sibling provider file directly.
 */

/** A provider-specific error distinct from a generic network/HTTP
 * failure, so callers (job.server.ts's error-message mapping) can tell
 * "the request never got a response in time" apart from other failure
 * modes without parsing error message text. */
export class ProviderTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms: ${what}`);
    this.name = "ProviderTimeoutError";
  }
}

/** The provider responded, but with a non-2xx status — `status` and a
 * merchant-safe `detail` (never the raw response body, which may contain
 * vendor-specific internals) are kept separately so a caller can log the
 * status without needing to re-parse the message string. */
export class ProviderRequestError extends Error {
  readonly status: number;

  constructor(providerName: string, status: number, detail?: string) {
    super(`${providerName} request failed with status ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "ProviderRequestError";
    this.status = status;
  }
}

/** The provider responded 2xx, but the response body didn't match the
 * shape this app expects (missing/malformed fields) — distinct from
 * `InvalidGenerationResultError` (services/generation/schema.ts), which
 * validates the NORMALIZED `GenerateImageResult` after mapping; this
 * error is for the raw wire response failing to map at all. */
export class ProviderResponseError extends Error {
  constructor(providerName: string, reason: string) {
    super(`${providerName} returned an unexpected response: ${reason}`);
    this.name = "ProviderResponseError";
  }
}

/** A request cannot succeed until the merchant's already-stored input is
 * replaced or repaired (for example, a signed reference URL returned an
 * HTML error document instead of image bytes). Unlike a timeout or 5xx,
 * retrying the same BullMQ payload cannot change that input, so workers
 * may safely mark it unrecoverable. The message deliberately contains no
 * URL, image bytes, credentials, or provider response body. */
export class ProviderInputError extends Error {
  constructor(providerName: string, reason: string) {
    super(`${providerName} could not use a reference image: ${reason}`);
    this.name = "ProviderInputError";
  }
}

/** `fetch` with a bounded timeout via `AbortController` — an aborted
 * request surfaces as `ProviderTimeoutError`, never a raw `AbortError`
 * (which reads as a merchant-initiated cancellation, not a timeout).
 * Every real provider's outbound network call should go through this
 * rather than calling `fetch` directly, so no worker can hang
 * indefinitely on a stalled upstream — see CLAUDE.md "AI provider rules"
 * and each provider's own doc comment. */
export async function fetchWithTimeout(
  url: string,
  what: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderTimeoutError(what, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Wall-clock latency of one provider call, in milliseconds — recorded
 * onto each result's `metadata.latencyMs` (see
 * production-image-generation-provider.server.ts) as usage-accounting-
 * adjacent detail, never used for retry/timeout decisions itself. */
export async function measureLatencyMs<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const startedAt = Date.now();
  const result = await fn();
  return { result, latencyMs: Date.now() - startedAt };
}
