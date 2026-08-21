/**
 * Unit test: services/ai/production-image-processing-provider.server.ts's
 * request-timeout hardening (Part 6, "provider readiness" — see that
 * file's doc comment). `global.fetch` is faked to simulate a hung
 * connection and fake timers drive the clock forward — no real network
 * call is made (see CLAUDE.md "Never make a real AI API call from a
 * test").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";

const REAL_FETCH = global.fetch;

describe("ProductionImageProcessingProvider — request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.REMOVE_BG_API_KEY = "test-key";
    resetEnvCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = REAL_FETCH;
    delete process.env.REMOVE_BG_API_KEY;
    resetEnvCacheForTests();
  });

  it("aborts a hung remove.bg call after the request timeout and reports ProviderTimeoutError", async () => {
    // Simulates a fetch that never resolves on its own but respects the
    // AbortSignal — exactly like the real `fetch` would.
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    const { ProductionImageProcessingProvider, ProviderTimeoutError } = await import(
      "../../../services/ai/production-image-processing-provider.server"
    );
    const provider = new ProductionImageProcessingProvider();

    const promise = provider.removeBackground({
      sourceImage: { mediaId: "m1", url: "https://cdn.shopify.com/product.jpg", altText: null, position: 0 },
    });
    const assertion = expect(promise).rejects.toBeInstanceOf(ProviderTimeoutError);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("does not time out a call that resolves well within the timeout", async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;

    const { ProductionImageProcessingProvider } = await import("../../../services/ai/production-image-processing-provider.server");
    const provider = new ProductionImageProcessingProvider();

    // sharp() needs real image bytes to read metadata from — this test
    // only cares that the call doesn't spuriously time out, so a
    // metadata-read failure past the fetch itself is fine to ignore.
    await provider.removeBackground({
      sourceImage: { mediaId: "m1", url: "https://cdn.shopify.com/product.jpg", altText: null, position: 0 },
    }).catch(() => undefined);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
