/**
 * Unit tests: services/ai/openai-image-provider.server.ts — the real
 * OpenAI `gpt-image-*` adapter. `global.fetch` is faked throughout — see
 * CLAUDE.md "Never make a real AI API call from a test".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { logger } from "../../../lib/logging/logger.server";
import { sizeForAspectRatio } from "../../../services/ai/openai-image-provider.server";
import { ProviderInputError, ProviderRequestError, ProviderResponseError } from "../../../services/ai/http-provider-utils.server";
import type { GenerateImageInput } from "../../../services/ai/types";

const REAL_FETCH = global.fetch;

async function validImageBytes(format: "jpeg" | "png" | "webp"): Promise<Uint8Array> {
  const source = sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } });
  const data = format === "jpeg" ? await source.jpeg().toBuffer() : format === "webp" ? await source.webp().toBuffer() : await source.png().toBuffer();
  return new Uint8Array(data);
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

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
  it("maps a square ratio to 1024x1024", () => {
    expect(sizeForAspectRatio("1:1")).toBe("1024x1024");
  });
  it("maps a portrait ratio to 1024x1536", () => {
    expect(sizeForAspectRatio("4:5")).toBe("1024x1536");
    expect(sizeForAspectRatio("9:16")).toBe("1024x1536");
  });
  it("maps a landscape ratio to 1536x1024", () => {
    expect(sizeForAspectRatio("16:9")).toBe("1536x1024");
    expect(sizeForAspectRatio("21:9")).toBe("1536x1024");
  });
  it("falls back to auto for an unrecognized ratio, never throwing", () => {
    expect(sizeForAspectRatio("not-a-ratio")).toBe("auto");
  });

  describe("plan resolution ceiling (maxDimensionPx)", () => {
    it("allows the full portrait/landscape sizes when no ceiling is given", () => {
      expect(sizeForAspectRatio("16:9", undefined)).toBe("1536x1024");
      expect(sizeForAspectRatio("16:9", null)).toBe("1536x1024");
    });

    it("allows portrait/landscape when the ceiling is at or above 1536", () => {
      expect(sizeForAspectRatio("16:9", 1536)).toBe("1536x1024");
      expect(sizeForAspectRatio("4:5", 2048)).toBe("1024x1536");
    });

    it("forces square when the ceiling is below 1536 (FREE plan's 1024), never silently generating a wider/taller canvas", () => {
      expect(sizeForAspectRatio("16:9", 1024)).toBe("1024x1024");
      expect(sizeForAspectRatio("4:5", 1024)).toBe("1024x1024");
      expect(sizeForAspectRatio("21:9", 1024)).toBe("1024x1024");
    });

    it("a square request stays square regardless of the ceiling", () => {
      expect(sizeForAspectRatio("1:1", 1024)).toBe("1024x1024");
      expect(sizeForAspectRatio("1:1", 2048)).toBe("1024x1024");
    });
  });
});

describe("OpenAIImageGenerationProvider", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER_API_KEY = "sk-test-key";
    resetEnvCacheForTests();
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_IMAGE_GENERATION_MODEL;
    delete process.env.AI_IMAGE_EDIT_MODEL;
    delete process.env.AI_PROVIDER_MODEL;
    resetEnvCacheForTests();
    vi.restoreAllMocks();
  });

  it("posts JSON to /v1/images/generations for a plain text-to-image request", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    const provider = new OpenAIImageGenerationProvider();
    const result = await provider.generateImage(baseInput());

    expect(capturedUrl).toBe("https://api.openai.com/v1/images/generations");
    expect(capturedBody?.model).toBe("gpt-image-2");
    expect(capturedBody?.quality).toBe("medium");
    expect(capturedBody?.size).toBe("1024x1024");
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].contentType).toBe("image/png");
  });

  it("clamps a wide aspect ratio to a square canvas when the plan's maxResolutionPx is below 1536", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    const provider = new OpenAIImageGenerationProvider();
    await provider.generateImage(baseInput({ aspectRatio: "16:9", maxResolutionPx: 1024 }));

    expect(capturedBody?.size).toBe("1024x1024");
  });

  it("allows the full landscape size when the plan's maxResolutionPx is 1536+", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    const provider = new OpenAIImageGenerationProvider();
    await provider.generateImage(baseInput({ aspectRatio: "16:9", maxResolutionPx: 1536 }));

    expect(capturedBody?.size).toBe("1536x1024");
  });

  it("uses a custom AI_PROVIDER_BASE_URL when set (e.g. a proxy)", async () => {
    process.env.AI_PROVIDER_BASE_URL = "https://my-proxy.example.com";
    resetEnvCacheForTests();
    let capturedUrl = "";
    global.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await new OpenAIImageGenerationProvider().generateImage(baseInput());
    expect(capturedUrl).toBe("https://my-proxy.example.com/v1/images/generations");
  });

  it("never includes the API key in the request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await new OpenAIImageGenerationProvider().generateImage(baseInput());
    expect(JSON.stringify(capturedBody)).not.toContain("sk-test-key");
  });

  it("posts multipart/form-data to /v1/images/edits for an editing mode", async () => {
    let editUrl = "";
    let editInit: RequestInit | undefined;
    const reference = await validImageBytes("png");
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://cdn.example.test/prior.png") {
        return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": "image/png" } });
      }
      editUrl = url;
      editInit = init;
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await new OpenAIImageGenerationProvider().generateImage(
      baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/prior.png", role: "previous_result" }] }),
    );

    expect(editUrl).toBe("https://api.openai.com/v1/images/edits");
    expect(editInit?.body).toBeInstanceOf(FormData);
    const form = editInit!.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("image")).toBeInstanceOf(Blob);
    // Never a manually-set Content-Type — fetch must set its own
    // multipart boundary, or OpenAI can't parse the body at all.
    expect((editInit?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("uses the image[] field name for more than one reference image", async () => {
    let form: FormData | undefined;
    const reference = await validImageBytes("png");
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://cdn.example.test/")) return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": "image/png" } });
      form = init!.body as FormData;
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await new OpenAIImageGenerationProvider().generateImage(
      baseInput({
        mode: "IMAGE_TO_IMAGE",
        referenceImages: [
          { url: "https://cdn.example.test/a.png", role: "product_original" },
          { url: "https://cdn.example.test/b.png", role: "previous_result" },
        ],
      }),
    );

    expect(form!.getAll("image[]")).toHaveLength(2);
    expect(form!.get("image")).toBeNull();
    expect((form!.getAll("image[]")[0] as File).name).toBe("reference-0.png");
    expect((form!.getAll("image[]")[1] as File).name).toBe("reference-1.png");
  });

  it("falls back to sourceImages when an editing mode has no explicit referenceImages", async () => {
    const calledUrls: string[] = [];
    const reference = await validImageBytes("png");
    global.fetch = vi.fn(async (url: string) => {
      calledUrls.push(url);
      if (url === "https://cdn.example.test/source.png") return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": "image/png" } });
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await new OpenAIImageGenerationProvider().generateImage(
      baseInput({ mode: "VARIATION", sourceImages: [{ mediaId: "m1", url: "https://cdn.example.test/source.png", altText: null, position: 0 }] }),
    );

    expect(calledUrls).toContain("https://cdn.example.test/source.png");
  });

  describe("PRODUCT FIDELITY quality-floor pass — reference images are sent whenever they exist, not gated on mode", () => {
    it("a TEXT_TO_IMAGE request (no mode set) with real sourceImages still posts to /v1/images/edits — the exact production-benchmark gap this fixes: a Shopify-context Creative Studio session's first turn, and every non-Creative-Studio generationType, previously never sent the real product photo at all", async () => {
      const calledUrls: string[] = [];
      const reference = await validImageBytes("png");
      global.fetch = vi.fn(async (url: string) => {
        calledUrls.push(url);
        if (url === "https://cdn.example.test/product.png") return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": "image/png" } });
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
      await new OpenAIImageGenerationProvider().generateImage(
        baseInput({ sourceImages: [{ mediaId: "m1", url: "https://cdn.example.test/product.png", altText: null, position: 0 }] }),
      );

      expect(calledUrls).toContain("https://cdn.example.test/product.png");
      expect(calledUrls.some((u) => u.endsWith("/v1/images/edits"))).toBe(true);
      expect(calledUrls.some((u) => u.endsWith("/v1/images/generations"))).toBe(false);
    });

    it("a plain text-to-image request genuinely has nothing to reference (empty sourceImages, no referenceImages) still posts to /v1/images/generations — unaffected", async () => {
      let capturedUrl = "";
      global.fetch = vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
      await new OpenAIImageGenerationProvider().generateImage(baseInput());
      expect(capturedUrl).toBe("https://api.openai.com/v1/images/generations");
    });
  });

  describe("PRODUCT FIDELITY quality-floor pass — reference image format is forwarded correctly, not mislabeled", () => {
    it.each([
      ["image/webp", "webp"],
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
    ])("forwards the reference image's real fetched Content-Type (%s) as the multipart part's type/filename, never hardcoding image/png", async (contentType, expectedExtension) => {
      let form: FormData | undefined;
      const reference = await validImageBytes(expectedExtension === "jpg" ? "jpeg" : expectedExtension === "png" ? "png" : "webp");
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://cdn.example.test/product.webp") {
          return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": contentType } });
        }
        form = init!.body as FormData;
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
      await new OpenAIImageGenerationProvider().generateImage(
        baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/product.webp", role: "product_original" }] }),
      );

      const file = form!.get("image") as File;
      expect(file.type).toBe(contentType);
      expect(file.name).toBe(`reference-0.${expectedExtension}`);
    });

    it("detects a valid JPEG from its bytes when the fetch response has no Content-Type", async () => {
      let form: FormData | undefined;
      const reference = await validImageBytes("jpeg");
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://cdn.example.test/product") {
          return new Response(responseBody(reference), { status: 200 });
        }
        form = init!.body as FormData;
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
      await new OpenAIImageGenerationProvider().generateImage(
        baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/product", role: "product_original" }] }),
      );

      const file = form!.get("image") as File;
      expect(file.type).toBe("image/jpeg");
      expect(file.name).toBe("reference-0.jpg");
    });

    it("uses the actual JPEG MIME type and filename when the declared response type is wrong", async () => {
      let form: FormData | undefined;
      const reference = await validImageBytes("jpeg");
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://cdn.example.test/mismatched") {
          return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": "image/png" } });
        }
        form = init!.body as FormData;
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
      await new OpenAIImageGenerationProvider().generateImage(
        baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/mismatched", role: "product_original" }] }),
      );

      const file = form!.get("image") as File;
      expect(file.type).toBe("image/jpeg");
      expect(file.name).toBe("reference-0.jpg");
    });

    it("normalizes a valid but non-sRGB JPEG to PNG before multipart upload", async () => {
      let form: FormData | undefined;
      const cmykJpeg = new Uint8Array(
        await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } } })
          .toColourspace("cmyk")
          .jpeg()
          .toBuffer(),
      );
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://cdn.example.test/cmyk.jpg") {
          return new Response(responseBody(cmykJpeg), { status: 200, headers: { "Content-Type": "image/jpeg" } });
        }
        form = init!.body as FormData;
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
      await new OpenAIImageGenerationProvider().generateImage(
        baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/cmyk.jpg", role: "product_original" }] }),
      );

      const file = form!.get("image") as File;
      expect(file.type).toBe("image/png");
      expect(file.name).toBe("reference-0.png");
      expect(new Uint8Array(await file.arrayBuffer()).slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });

    it.each([
      ["an HTML response", new TextEncoder().encode("<html>expired signature</html>")],
      ["an empty response", new Uint8Array()],
    ])("fails locally for %s before making an OpenAI edit request", async (_label, reference) => {
      let editRequests = 0;
      global.fetch = vi.fn(async (url: string) => {
        if (url === "https://cdn.example.test/invalid") {
          return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": "image/png" } });
        }
        editRequests += 1;
        return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
      }) as unknown as typeof fetch;

      const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
      await expect(
        new OpenAIImageGenerationProvider().generateImage(
          baseInput({ mode: "IMAGE_TO_IMAGE", referenceImages: [{ url: "https://cdn.example.test/invalid", role: "product_original" }] }),
        ),
      ).rejects.toBeInstanceOf(ProviderInputError);
      expect(editRequests).toBe(0);
    });
  });

  it("uses AI_IMAGE_EDIT_MODEL for edits and AI_IMAGE_GENERATION_MODEL for plain generation", async () => {
    process.env.AI_IMAGE_EDIT_MODEL = "gpt-image-1-edit-preview";
    process.env.AI_IMAGE_GENERATION_MODEL = "gpt-image-1-gen-preview";
    resetEnvCacheForTests();

    let lastModel: unknown;
    const reference = await validImageBytes("png");
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://cdn.example.test/")) return new Response(responseBody(reference), { status: 200, headers: { "Content-Type": "image/png" } });
      if (init?.body instanceof FormData) {
        lastModel = init.body.get("model");
      } else {
        lastModel = JSON.parse(init!.body as string).model;
      }
      return new Response(JSON.stringify({ data: [{ b64_json: "AA==" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    const provider = new OpenAIImageGenerationProvider();

    await provider.generateImage(
      baseInput({ mode: "IMAGE_EDIT", referenceImages: [{ url: "https://cdn.example.test/prior.png", role: "previous_result" }] }),
    );
    expect(lastModel).toBe("gpt-image-1-edit-preview");

    await provider.generateImage(baseInput());
    expect(lastModel).toBe("gpt-image-1-gen-preview");
  });

  it("throws ProviderRequestError with the status code on a non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await expect(new OpenAIImageGenerationProvider().generateImage(baseInput())).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("throws ProviderRequestError (not a special auth type) on a 401 — status is still classifiable via .status", async () => {
    global.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    try {
      await new OpenAIImageGenerationProvider().generateImage(baseInput());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect((error as ProviderRequestError).status).toBe(401);
    }
  });

  it("throws ProviderResponseError for a malformed (non-JSON) response body", async () => {
    global.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await expect(new OpenAIImageGenerationProvider().generateImage(baseInput())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("throws ProviderResponseError when the response has an empty data[] array", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await expect(new OpenAIImageGenerationProvider().generateImage(baseInput())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("logs OpenAI's sanitized error envelope (message/type/code/param) on a non-2xx response, never the raw body or the API key", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "The model `gpt-image-1` does not exist or you do not have access to it",
              type: "invalid_request_error",
              code: "model_not_found",
              param: "model",
            },
          }),
          { status: 404 },
        ),
    ) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await expect(new OpenAIImageGenerationProvider().generateImage(baseInput())).rejects.toBeInstanceOf(ProviderRequestError);

    const matches = errorSpy.mock.calls.filter(([message]) => message === "ai_provider.generation.request_failed");
    const call = matches[matches.length - 1];
    expect(call).toBeDefined();
    const fields = call![1] as Record<string, unknown>;
    expect(fields.status).toBe(404);
    expect(fields.errorCode).toBe("model_not_found");
    expect(fields.errorType).toBe("invalid_request_error");
    expect(fields.errorParam).toBe("model");
    expect(fields.errorMessage).toContain("does not exist");
    expect(JSON.stringify(fields)).not.toContain("sk-test-key");
  });

  it("never throws while parsing a non-JSON error body — falls back to null fields", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async () => new Response("<html>gateway error</html>", { status: 502 })) as unknown as typeof fetch;

    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await expect(new OpenAIImageGenerationProvider().generateImage(baseInput())).rejects.toBeInstanceOf(ProviderRequestError);

    const matches = errorSpy.mock.calls.filter(([message]) => message === "ai_provider.generation.request_failed");
    const call = matches[matches.length - 1];
    const fields = call![1] as Record<string, unknown>;
    expect(fields.status).toBe(502);
    expect(fields.errorMessage).toBeNull();
  });

  it("throws when AI_PROVIDER_API_KEY is unset", async () => {
    delete process.env.AI_PROVIDER_API_KEY;
    resetEnvCacheForTests();
    const { OpenAIImageGenerationProvider } = await import("../../../services/ai/openai-image-provider.server");
    await expect(new OpenAIImageGenerationProvider().generateImage(baseInput())).rejects.toThrow(/requires AI_PROVIDER_API_KEY/);
  });
});
