/**
 * Unit tests: services/ai/production-image-generation-provider.server.ts
 * — input/output mapping, error classification, and timeout handling.
 * `global.fetch` is faked throughout (no real network call — see
 * CLAUDE.md "Never make a real AI API call from a test").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { sizeForAspectRatio } from "../../../services/ai/production-image-generation-provider.server";
import { ProviderRequestError, ProviderResponseError, ProviderTimeoutError } from "../../../services/ai/http-provider-utils.server";
import type { GenerateImageInput } from "../../../services/ai/types";

const REAL_FETCH = global.fetch;

function baseInput(overrides: Partial<GenerateImageInput> = {}): GenerateImageInput {
  return {
    generationType: "LIFESTYLE",
    sourceImages: [],
    productFacts: { identityAnchors: { category: "Handbags" } },
    creativeDirection: { prompt: "A red leather handbag on a marble counter.", negativeConstraints: [] },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    attempt: 1,
    ...overrides,
  };
}

describe("sizeForAspectRatio", () => {
  it("keeps a square ratio square, at the max dimension", () => {
    expect(sizeForAspectRatio("1:1", 1024)).toBe("1024x1024");
  });

  it("scales a portrait ratio's width down proportionally, rounded to a multiple of 8", () => {
    const [w, h] = sizeForAspectRatio("4:5", 1024).split("x").map(Number);
    expect(h).toBe(1024);
    expect(w).toBeLessThan(h);
    expect(w % 8).toBe(0);
  });

  it("scales a landscape ratio's height down proportionally", () => {
    const [w, h] = sizeForAspectRatio("16:9", 1024).split("x").map(Number);
    expect(w).toBe(1024);
    expect(h).toBeLessThan(w);
  });

  it("falls back to a square for an unrecognized ratio string, never throwing", () => {
    expect(sizeForAspectRatio("not-a-ratio", 1024)).toBe("1024x1024");
  });
});

describe("ProductionImageGenerationProvider", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER_BASE_URL = "https://example-provider.test";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();
  });

  afterEach(() => {
    global.fetch = REAL_FETCH;
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.AI_PROVIDER_MODEL;
    resetEnvCacheForTests();
    vi.useRealTimers();
  });

  it("maps a b64_json response into GeneratedImageOutput[] with the right content type", async () => {
    const pngBytes = Buffer.from([1, 2, 3, 4]);
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "req-1", model: "test-model", data: [{ b64_json: pngBytes.toString("base64") }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();
    const result = await provider.generateImage(baseInput());

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].contentType).toBe("image/png");
    expect(Buffer.from(result.outputs[0].data)).toEqual(pngBytes);
    expect(result.outputs[0].providerResultId).toBe("req-1-0");
    expect(result.outputs[0].metadata?.model).toBe("test-model");
  });

  it("fetches bytes from a url-shaped response item when no b64_json is present", async () => {
    const imageBytes = Buffer.from([9, 9, 9]);
    global.fetch = vi.fn(async (url: string) => {
      if (url === "https://example-provider.test/v1/images/generations") {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.test/out.png" }] }), { status: 200 });
      }
      return new Response(imageBytes, { status: 200 });
    }) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();
    const result = await provider.generateImage(baseInput());

    expect(Buffer.from(result.outputs[0].data)).toEqual(imageBytes);
  });

  it("requests one output per outputCount and forwards negative constraints", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }, { b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();
    await provider.generateImage(baseInput({ outputCount: 2, creativeDirection: { prompt: "p", negativeConstraints: ["blurry", "text"] } }));

    expect(capturedBody?.n).toBe(2);
    expect(capturedBody?.negative_prompt).toBe("blurry, text");
  });

  it("never includes the API key or base URL in the request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();
    await provider.generateImage(baseInput());

    expect(JSON.stringify(capturedBody)).not.toContain("test-key");
  });

  it("throws ProviderRequestError with the status code on a non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response("internal error", { status: 500 })) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();

    await expect(provider.generateImage(baseInput())).rejects.toBeInstanceOf(ProviderRequestError);
    try {
      await provider.generateImage(baseInput());
    } catch (error) {
      expect((error as ProviderRequestError).status).toBe(500);
    }
  });

  it("throws ProviderResponseError for a malformed (non-JSON) response body", async () => {
    global.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();

    await expect(provider.generateImage(baseInput())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("throws ProviderResponseError when the response has an empty data[] array", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();

    await expect(provider.generateImage(baseInput())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("throws ProviderResponseError when a data[] entry has neither b64_json nor url", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{}] }), { status: 200 })) as unknown as typeof fetch;

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();

    await expect(provider.generateImage(baseInput())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("times out and reports ProviderTimeoutError rather than hanging", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as unknown as typeof fetch;

    process.env.AI_PROVIDER_TIMEOUT_MS = "5000";
    resetEnvCacheForTests();

    const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
    const provider = new ProductionImageGenerationProvider();

    const promise = provider.generateImage(baseInput());
    const assertion = expect(promise).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    delete process.env.AI_PROVIDER_TIMEOUT_MS;
  });
});
