import { describe, expect, it } from "vitest";
import {
  DeterministicTestImageGenerationProvider,
  FORCE_FAILURE_ALWAYS,
  FORCE_FAILURE_ONCE,
} from "../../../services/generation/deterministic-test-provider.server";
import type { GenerateImageInput } from "../../../services/ai/types";

function input(overrides: Partial<GenerateImageInput> = {}): GenerateImageInput {
  return {
    generationType: "PRODUCT_CLEANUP",
    sourceImages: [{ mediaId: "media-1", url: "https://cdn/1.jpg", altText: null, position: 0 }],
    productFacts: {},
    creativeDirection: { prompt: "Clean product photography.", negativeConstraints: [] },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    attempt: 1,
    ...overrides,
  };
}

describe("DeterministicTestImageGenerationProvider", () => {
  it("produces a well-formed output with real, non-empty image bytes", async () => {
    const provider = new DeterministicTestImageGenerationProvider();
    const result = await provider.generateImage(input());

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].data.byteLength).toBeGreaterThan(0);
    expect(result.outputs[0].contentType).toBe("image/png");
  });

  it("produces exactly `outputCount` outputs", async () => {
    const provider = new DeterministicTestImageGenerationProvider();
    const result = await provider.generateImage(input({ outputCount: 3 }));
    expect(result.outputs).toHaveLength(3);
  });

  it("is deterministic — identical input produces identical provider/result ids", async () => {
    const provider = new DeterministicTestImageGenerationProvider();
    const a = await provider.generateImage(input());
    const b = await provider.generateImage(input());
    expect(a.providerJobId).toBe(b.providerJobId);
    expect(a.outputs[0].providerResultId).toBe(b.outputs[0].providerResultId);
  });

  it("throws on every attempt when FORCE_FAILURE_ALWAYS is set", async () => {
    const provider = new DeterministicTestImageGenerationProvider();
    const failingInput = input({
      creativeDirection: { prompt: "x", negativeConstraints: [FORCE_FAILURE_ALWAYS] },
    });
    await expect(provider.generateImage({ ...failingInput, attempt: 1 })).rejects.toThrow();
    await expect(provider.generateImage({ ...failingInput, attempt: 2 })).rejects.toThrow();
  });

  it("throws only on the first attempt when FORCE_FAILURE_ONCE is set, then succeeds", async () => {
    const provider = new DeterministicTestImageGenerationProvider();
    const flakyInput = input({
      creativeDirection: { prompt: "x", negativeConstraints: [FORCE_FAILURE_ONCE] },
    });
    await expect(provider.generateImage({ ...flakyInput, attempt: 1 })).rejects.toThrow();
    await expect(provider.generateImage({ ...flakyInput, attempt: 2 })).resolves.toBeDefined();
  });
});
