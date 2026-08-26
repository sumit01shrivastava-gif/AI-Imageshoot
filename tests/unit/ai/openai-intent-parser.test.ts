/**
 * Unit tests: services/ai/openai-intent-parser.server.ts — the real,
 * OpenAI-Chat-Completions-backed `IntentParsingProvider`, activated by
 * the SAME `AI_PROVIDER=openai`/`AI_PROVIDER_API_KEY` credentials this
 * deployment already uses for real image generation. `global.fetch` is
 * faked throughout — see CLAUDE.md "Never make a real AI API call from
 * a test".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { ProviderRequestError, ProviderResponseError } from "../../../services/ai/http-provider-utils.server";
import { CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION } from "../../../services/ai/creative-director-instructions";
import type { ParseIntentInput } from "../../../services/ai/types";

const REAL_FETCH = global.fetch;

const INPUT: ParseIntentInput = { message: "Put it in a luxury bathroom", creativeContext: { active: true }, candidateResultCount: 2 };

function chatCompletionResponse(contentObject: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(contentObject) } }] }), { status });
}

describe("OpenAIIntentParsingProvider", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
    delete process.env.AI_PROVIDER_API_KEY;
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_PROVIDER_MODEL;
    delete process.env.AI_PROVIDER_INTENT_MODEL;
    resetEnvCacheForTests();
  });

  it("throws when AI_PROVIDER_API_KEY is unset", async () => {
    delete process.env.AI_PROVIDER_API_KEY;
    resetEnvCacheForTests();
    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await expect(new OpenAIIntentParsingProvider().parseIntent(INPUT)).rejects.toThrow(/requires/);
  });

  it("posts to the real OpenAI chat completions endpoint, defaulting the base URL", async () => {
    let capturedUrl = "";
    global.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
    }) as unknown as typeof fetch;

    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await new OpenAIIntentParsingProvider().parseIntent(INPUT);

    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses a custom AI_PROVIDER_BASE_URL when set", async () => {
    process.env.AI_PROVIDER_BASE_URL = "https://self-hosted.example.test";
    resetEnvCacheForTests();
    let capturedUrl = "";
    global.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
    }) as unknown as typeof fetch;

    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await new OpenAIIntentParsingProvider().parseIntent(INPUT);

    expect(capturedUrl).toBe("https://self-hosted.example.test/v1/chat/completions");
  });

  it("sends the real creative-director system instruction as the system message, and the message/context as a JSON text part", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
    }) as unknown as typeof fetch;

    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await new OpenAIIntentParsingProvider().parseIntent(INPUT);

    const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: "system", content: CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION });
    expect(messages[1].role).toBe("user");
    const userContent = messages[1].content as Array<{ type: string; text?: string }>;
    expect(userContent[0].type).toBe("text");
    const decoded = JSON.parse(userContent[0].text!);
    expect(decoded.message).toBe(INPUT.message);
    expect(decoded.creativeContext).toEqual(INPUT.creativeContext);
    expect(decoded.candidateResultCount).toBe(INPUT.candidateResultCount);

    // Real structured-output mode, so the model can't return prose/markdown.
    expect(capturedBody!.response_format).toEqual({ type: "json_object" });
  });

  it("includes an image_url content part per referenceImageUrls entry, in OpenAI's real vision-input shape", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
    }) as unknown as typeof fetch;

    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await new OpenAIIntentParsingProvider().parseIntent({
      ...INPUT,
      referenceImageUrls: ["https://storage.example.test/a.png", "https://storage.example.test/b.png"],
    });

    const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
    const userContent = messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    const imageParts = userContent.filter((part) => part.type === "image_url");
    expect(imageParts).toEqual([
      { type: "image_url", image_url: { url: "https://storage.example.test/a.png" } },
      { type: "image_url", image_url: { url: "https://storage.example.test/b.png" } },
    ]);
  });

  it("sends no image_url parts when referenceImageUrls is empty/absent", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
    }) as unknown as typeof fetch;

    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await new OpenAIIntentParsingProvider().parseIntent(INPUT);

    const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>;
    const userContent = messages[1].content as Array<{ type: string }>;
    expect(userContent.some((part) => part.type === "image_url")).toBe(false);
  });

  describe("model resolution", () => {
    it("defaults to gpt-4o-mini when nothing else is configured", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
      }) as unknown as typeof fetch;
      const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
      await new OpenAIIntentParsingProvider().parseIntent(INPUT);
      expect(capturedBody!.model).toBe("gpt-4o-mini");
    });

    it("AI_PROVIDER_MODEL overrides the default", async () => {
      process.env.AI_PROVIDER_MODEL = "gpt-4o";
      resetEnvCacheForTests();
      let capturedBody: Record<string, unknown> | undefined;
      global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
      }) as unknown as typeof fetch;
      const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
      await new OpenAIIntentParsingProvider().parseIntent(INPUT);
      expect(capturedBody!.model).toBe("gpt-4o");
    });

    it("AI_PROVIDER_INTENT_MODEL overrides AI_PROVIDER_MODEL", async () => {
      process.env.AI_PROVIDER_MODEL = "gpt-4o";
      process.env.AI_PROVIDER_INTENT_MODEL = "gpt-4.1-mini";
      resetEnvCacheForTests();
      let capturedBody: Record<string, unknown> | undefined;
      global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init!.body as string);
        return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
      }) as unknown as typeof fetch;
      const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
      await new OpenAIIntentParsingProvider().parseIntent(INPUT);
      expect(capturedBody!.model).toBe("gpt-4.1-mini");
    });
  });

  it("parses the chat completion's JSON-string content into the returned ParsedIntentRawOutput", async () => {
    global.fetch = vi.fn(async () =>
      chatCompletionResponse({ intent: "CHANGE_SCENE", mode: "IMAGE_TO_IMAGE", scene: "a rooftop", changeSummary: "scene: rooftop" }),
    ) as unknown as typeof fetch;

    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    const result = await new OpenAIIntentParsingProvider().parseIntent(INPUT);

    expect(result).toEqual({ intent: "CHANGE_SCENE", mode: "IMAGE_TO_IMAGE", scene: "a rooftop", changeSummary: "scene: rooftop" });
  });

  it("throws ProviderRequestError on a non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await expect(new OpenAIIntentParsingProvider().parseIntent(INPUT)).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("throws ProviderResponseError when the response body isn't valid JSON", async () => {
    global.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await expect(new OpenAIIntentParsingProvider().parseIntent(INPUT)).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("throws ProviderResponseError when there is no chat completion content", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await expect(new OpenAIIntentParsingProvider().parseIntent(INPUT)).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("throws ProviderResponseError when the completion content is not valid JSON (a model that ignored json_object mode)", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "Sure, here you go: {intent: broken}" } }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await expect(new OpenAIIntentParsingProvider().parseIntent(INPUT)).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("throws ProviderResponseError when the completion content is valid JSON but not an object (e.g. a bare array/string)", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: "[1,2,3]" } }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await expect(new OpenAIIntentParsingProvider().parseIntent(INPUT)).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("never sends the API key in the request body", async () => {
    let capturedBody = "";
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = init!.body as string;
      return chatCompletionResponse({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" });
    }) as unknown as typeof fetch;
    const { OpenAIIntentParsingProvider } = await import("../../../services/ai/openai-intent-parser.server");
    await new OpenAIIntentParsingProvider().parseIntent(INPUT);
    expect(capturedBody).not.toContain("test-key");
  });
});
