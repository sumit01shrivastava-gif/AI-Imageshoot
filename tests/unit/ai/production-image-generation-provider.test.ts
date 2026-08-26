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

  afterEach(() => {
    delete process.env.AI_IMAGE_GENERATION_MODEL;
    delete process.env.AI_IMAGE_EDIT_MODEL;
    resetEnvCacheForTests();
  });

  describe("image-to-image / edit requests", () => {
    it("posts to /v1/images/edits, not /v1/images/generations, when mode is an editing mode", async () => {
      const calledUrls: string[] = [];
      global.fetch = vi.fn(async (url: string) => {
        calledUrls.push(url);
        if (url.endsWith("/v1/images/edits")) {
          return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
        }
        return new Response(Buffer.from([1, 2, 3]), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();
      await provider.generateImage(
        baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/prior.png", role: "previous_result" }] }),
      );

      expect(calledUrls.some((u) => u.endsWith("/v1/images/edits"))).toBe(true);
      expect(calledUrls.some((u) => u.endsWith("/v1/images/generations"))).toBe(false);
    });

    it("falls back to /v1/images/generations for a plain text-to-image request (no mode set)", async () => {
      const calledUrls: string[] = [];
      global.fetch = vi.fn(async (url: string) => {
        calledUrls.push(url);
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();
      await provider.generateImage(baseInput());

      expect(calledUrls[0]).toContain("/v1/images/generations");
    });

    it("fetches and base64-encodes a single reference image into the edits request body's `image` field", async () => {
      const referenceBytes = Buffer.from([5, 6, 7]);
      let editRequestBody: Record<string, unknown> | undefined;
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://cdn.example.test/prior.png") {
          return new Response(referenceBytes, { status: 200 });
        }
        editRequestBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();
      await provider.generateImage(
        baseInput({ mode: "IMAGE_EDIT", referenceImages: [{ url: "https://cdn.example.test/prior.png", role: "previous_result" }] }),
      );

      expect(editRequestBody?.image).toBe(referenceBytes.toString("base64"));
      expect(editRequestBody?.images).toBeUndefined();
    });

    it("sends multiple references as `images[]`, not `image`", async () => {
      let editRequestBody: Record<string, unknown> | undefined;
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://cdn.example.test/")) {
          return new Response(Buffer.from([1]), { status: 200 });
        }
        editRequestBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();
      await provider.generateImage(
        baseInput({
          mode: "IMAGE_TO_IMAGE",
          referenceImages: [
            { url: "https://cdn.example.test/a.png", role: "product_original" },
            { url: "https://cdn.example.test/b.png", role: "previous_result" },
          ],
        }),
      );

      expect(Array.isArray(editRequestBody?.images)).toBe(true);
      expect((editRequestBody?.images as string[]).length).toBe(2);
      expect(editRequestBody?.image).toBeUndefined();
    });

    it("PRODUCT FIDELITY quality-floor pass: a plain request (no mode set) with real sourceImages still posts to /v1/images/edits — the exact production-benchmark gap this fixes: every non-Creative-Studio generationType (PRODUCT_CLEANUP/LIFESTYLE/MODEL_SHOOT/BANNER/CTA never set `mode` at all) previously never sent the real product photo to this provider", async () => {
      const calledUrls: string[] = [];
      global.fetch = vi.fn(async (url: string) => {
        calledUrls.push(url);
        if (url === "https://cdn.example.test/product.png") return new Response(Buffer.from([1, 2, 3]), { status: 200 });
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();
      await provider.generateImage(
        baseInput({ sourceImages: [{ mediaId: "m1", url: "https://cdn.example.test/product.png", altText: null, position: 0 }] }),
      );

      expect(calledUrls).toContain("https://cdn.example.test/product.png");
      expect(calledUrls.some((u) => u.endsWith("/v1/images/edits"))).toBe(true);
      expect(calledUrls.some((u) => u.endsWith("/v1/images/generations"))).toBe(false);
    });

    it("a plain request that genuinely has nothing to reference (empty sourceImages, no mode) still posts to /v1/images/generations — unaffected", async () => {
      const calledUrls: string[] = [];
      global.fetch = vi.fn(async (url: string) => {
        calledUrls.push(url);
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();
      await provider.generateImage(baseInput());
      expect(calledUrls[0]).toContain("/v1/images/generations");
    });

    it("falls back to sourceImages when an editing mode has no explicit referenceImages", async () => {
      const calledUrls: string[] = [];
      global.fetch = vi.fn(async (url: string) => {
        calledUrls.push(url);
        if (url === "https://cdn.example.test/source.png") {
          return new Response(Buffer.from([1]), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();
      await provider.generateImage(
        baseInput({ mode: "VARIATION", sourceImages: [{ mediaId: "m1", url: "https://cdn.example.test/source.png", altText: null, position: 0 }] }),
      );

      expect(calledUrls).toContain("https://cdn.example.test/source.png");
    });

    it("uses AI_IMAGE_EDIT_MODEL for an edit request and AI_IMAGE_GENERATION_MODEL for a plain request", async () => {
      process.env.AI_IMAGE_EDIT_MODEL = "edit-model-v1";
      process.env.AI_IMAGE_GENERATION_MODEL = "gen-model-v1";
      resetEnvCacheForTests();

      let lastBody: Record<string, unknown> | undefined;
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://cdn.example.test/")) return new Response(Buffer.from([1]), { status: 200 });
        lastBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();

      await provider.generateImage(
        baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/prior.png", role: "previous_result" }] }),
      );
      expect(lastBody?.model).toBe("edit-model-v1");

      await provider.generateImage(baseInput());
      expect(lastBody?.model).toBe("gen-model-v1");
    });

    it("throws a ProviderResponseError (not a raw fetch error) when a reference image fails to fetch", async () => {
      global.fetch = vi.fn(async (url: string) => {
        if (url.startsWith("https://cdn.example.test/")) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { ProductionImageGenerationProvider } = await import("../../../services/ai/production-image-generation-provider.server");
      const provider = new ProductionImageGenerationProvider();

      await expect(
        provider.generateImage(
          baseInput({ mode: "IMAGE_EDIT", referenceImages: [{ url: "https://cdn.example.test/missing.png", role: "previous_result" }] }),
        ),
      ).rejects.toBeInstanceOf(ProviderResponseError);
    });
  });
});
