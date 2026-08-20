import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicTestImageProcessingProvider,
  FORCE_FAILURE_ALWAYS,
  FORCE_FAILURE_ONCE,
  resetDeterministicProcessingProviderStateForTests,
} from "../../../services/processing/deterministic-test-provider.server";
import type { ImageProcessingInput } from "../../../services/ai/types";

afterEach(() => {
  resetDeterministicProcessingProviderStateForTests();
});

function input(overrides: Partial<ImageProcessingInput> = {}): ImageProcessingInput {
  return {
    sourceImage: { mediaId: "media-1", url: "https://cdn/1.jpg", altText: null, position: 0 },
    options: {},
    ...overrides,
  };
}

describe("DeterministicTestImageProcessingProvider", () => {
  it("removeBackground produces a well-formed output with real, non-empty image bytes", async () => {
    const provider = new DeterministicTestImageProcessingProvider();
    const output = await provider.removeBackground(input());
    expect(output.data.byteLength).toBeGreaterThan(0);
    expect(output.contentType).toBe("image/png");
  });

  it("enhance and resize also succeed deterministically", async () => {
    const provider = new DeterministicTestImageProcessingProvider();
    const enhanced = await provider.enhance(input({ sourceImage: { mediaId: "m2", url: "https://cdn/2.jpg", altText: null, position: 0 } }));
    const resized = await provider.resize(
      input({ sourceImage: { mediaId: "m3", url: "https://cdn/3.jpg", altText: null, position: 0 }, options: { aspectRatio: "1:1" } }),
    );
    expect(enhanced.contentType).toBe("image/png");
    expect(resized.contentType).toBe("image/png");
  });

  it("is deterministic — identical input produces identical providerResultId metadata", async () => {
    const provider = new DeterministicTestImageProcessingProvider();
    const sourceImage = { mediaId: "media-fixed", url: "https://cdn/fixed.jpg", altText: null, position: 0 };
    const a = await provider.removeBackground(input({ sourceImage }));
    const b = await provider.removeBackground(input({ sourceImage }));
    expect(a.metadata?.providerResultId).toBe(b.metadata?.providerResultId);
  });

  it("throws on every attempt when the source image's altText carries FORCE_FAILURE_ALWAYS", async () => {
    const provider = new DeterministicTestImageProcessingProvider();
    const failingInput = input({
      sourceImage: { mediaId: "m", url: "https://cdn/fail.jpg", altText: FORCE_FAILURE_ALWAYS, position: 0 },
    });
    await expect(provider.removeBackground(failingInput)).rejects.toThrow();
    await expect(provider.removeBackground(failingInput)).rejects.toThrow();
  });

  it("throws only on the first attempt when altText carries FORCE_FAILURE_ONCE, then succeeds", async () => {
    const provider = new DeterministicTestImageProcessingProvider();
    const flakyInput = input({
      sourceImage: { mediaId: "m", url: "https://cdn/flaky-once.jpg", altText: FORCE_FAILURE_ONCE, position: 0 },
    });
    await expect(provider.removeBackground(flakyInput)).rejects.toThrow();
    await expect(provider.removeBackground(flakyInput)).resolves.toBeDefined();
  });
});
