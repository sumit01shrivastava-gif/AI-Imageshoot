import { describe, expect, it } from "vitest";
import { buildImageProcessingInput } from "../../../services/processing/build-input";
import type { ProductImageReference } from "../../../services/ai/types";

describe("buildImageProcessingInput", () => {
  it("carries the source image and options through verbatim", () => {
    const sourceImage: ProductImageReference = {
      mediaId: "media-1",
      url: "https://cdn/1.jpg",
      altText: "Front",
      position: 0,
    };
    const input = buildImageProcessingInput(sourceImage, { aspectRatio: "16:9" });

    expect(input.sourceImage).toBe(sourceImage);
    expect(input.options).toEqual({ aspectRatio: "16:9" });
  });

  it("passes empty options through unchanged", () => {
    const sourceImage: ProductImageReference = { mediaId: "m", url: "https://cdn/1.jpg", altText: null, position: 0 };
    const input = buildImageProcessingInput(sourceImage, {});
    expect(input.options).toEqual({});
  });
});
