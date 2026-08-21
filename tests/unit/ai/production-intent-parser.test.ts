/**
 * Unit tests: services/ai/production-intent-parser.server.ts — the
 * real-LLM `IntentParsingProvider` implementation and its
 * `FallbackIntentParser` wrapper. `global.fetch` is faked throughout —
 * see CLAUDE.md "Never make a real AI API call from a test".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../../../lib/validation/env.server";
import { ProviderRequestError, ProviderResponseError } from "../../../services/ai/http-provider-utils.server";
import type { IntentParsingProvider, ParseIntentInput, ParsedIntentRawOutput } from "../../../services/ai/types";

const REAL_FETCH = global.fetch;

const INPUT: ParseIntentInput = { message: "Put it in a luxury bathroom", creativeContext: {}, candidateResultCount: 0 };

describe("ProductionIntentParsingProvider", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER_BASE_URL = "https://example-provider.test";
    process.env.AI_PROVIDER_API_KEY = "test-key";
    resetEnvCacheForTests();
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    resetEnvCacheForTests();
  });

  it("posts to /v1/intent/parse and returns the parsed JSON body", async () => {
    const raw: ParsedIntentRawOutput = {
      intent: "CHANGE_SCENE",
      mode: "IMAGE_TO_IMAGE",
      scene: "luxury bathroom",
      changeSummary: "scene: luxury bathroom",
    };
    global.fetch = vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 })) as unknown as typeof fetch;

    const { ProductionIntentParsingProvider } = await import("../../../services/ai/production-intent-parser.server");
    const provider = new ProductionIntentParsingProvider();
    const result = await provider.parseIntent(INPUT);

    expect(result).toEqual(raw);
  });

  it("never sends the API key or base URL in the request body", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ intent: "VARIATION", mode: "VARIATION", changeSummary: "x" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { ProductionIntentParsingProvider } = await import("../../../services/ai/production-intent-parser.server");
    await new ProductionIntentParsingProvider().parseIntent(INPUT);

    expect(JSON.stringify(capturedBody)).not.toContain("test-key");
  });

  it("throws ProviderRequestError on a non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response("error", { status: 500 })) as unknown as typeof fetch;
    const { ProductionIntentParsingProvider } = await import("../../../services/ai/production-intent-parser.server");
    await expect(new ProductionIntentParsingProvider().parseIntent(INPUT)).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("throws ProviderResponseError for a malformed (non-JSON) response body", async () => {
    global.fetch = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const { ProductionIntentParsingProvider } = await import("../../../services/ai/production-intent-parser.server");
    await expect(new ProductionIntentParsingProvider().parseIntent(INPUT)).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("throws when AI_PROVIDER_BASE_URL/AI_PROVIDER_API_KEY are unset", async () => {
    delete process.env.AI_PROVIDER_BASE_URL;
    delete process.env.AI_PROVIDER_API_KEY;
    resetEnvCacheForTests();
    const { ProductionIntentParsingProvider } = await import("../../../services/ai/production-intent-parser.server");
    await expect(new ProductionIntentParsingProvider().parseIntent(INPUT)).rejects.toThrow(/requires/);
  });
});

describe("FallbackIntentParser", () => {
  it("returns the primary provider's result when it succeeds", async () => {
    const primary: IntentParsingProvider = {
      name: "primary",
      parseIntent: vi.fn(async () => ({ intent: "VARIATION" as const, mode: "VARIATION" as const, changeSummary: "primary result" })),
    };
    const fallback: IntentParsingProvider = { name: "fallback", parseIntent: vi.fn() };

    const { FallbackIntentParser } = await import("../../../services/ai/production-intent-parser.server");
    const parser = new FallbackIntentParser(primary, fallback);
    const result = await parser.parseIntent(INPUT);

    expect(result.changeSummary).toBe("primary result");
    expect(fallback.parseIntent).not.toHaveBeenCalled();
  });

  it("falls back to the secondary provider when the primary throws", async () => {
    const primary: IntentParsingProvider = {
      name: "primary",
      parseIntent: vi.fn(async () => {
        throw new Error("primary is down");
      }),
    };
    const fallback: IntentParsingProvider = {
      name: "fallback",
      parseIntent: vi.fn(async () => ({ intent: "VARIATION" as const, mode: "VARIATION" as const, changeSummary: "fallback result" })),
    };

    const { FallbackIntentParser } = await import("../../../services/ai/production-intent-parser.server");
    const parser = new FallbackIntentParser(primary, fallback);
    const result = await parser.parseIntent(INPUT);

    expect(result.changeSummary).toBe("fallback result");
    expect(fallback.parseIntent).toHaveBeenCalledWith(INPUT);
  });

  it("names itself after both providers, for observability", async () => {
    const primary: IntentParsingProvider = { name: "production-llm", parseIntent: vi.fn() };
    const fallback: IntentParsingProvider = { name: "heuristic", parseIntent: vi.fn() };
    const { FallbackIntentParser } = await import("../../../services/ai/production-intent-parser.server");
    const parser = new FallbackIntentParser(primary, fallback);
    expect(parser.name).toContain("production-llm");
    expect(parser.name).toContain("heuristic");
  });
});
