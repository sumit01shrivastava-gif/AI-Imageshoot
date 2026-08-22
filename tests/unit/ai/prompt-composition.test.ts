/**
 * Unit tests: services/ai/prompt-composition.ts — the shared, provider
 * -agnostic prompt/grounding-prefix builder.
 */
import { describe, expect, it } from "vitest";
import { composeProductGroundingPrefix, composeProviderPrompt } from "../../../services/ai/prompt-composition";
import type { GenerateImageInput } from "../../../services/ai/types";

function baseInput(overrides: Partial<GenerateImageInput> = {}): GenerateImageInput {
  return {
    generationType: "LIFESTYLE",
    sourceImages: [],
    productFacts: { identityAnchors: null },
    creativeDirection: { prompt: "A red leather handbag on a marble counter.", negativeConstraints: [] },
    aspectRatio: "1:1",
    outputFormat: "png",
    quality: "standard",
    outputCount: 1,
    attempt: 1,
    ...overrides,
  };
}

describe("composeProductGroundingPrefix", () => {
  it("returns an empty string when neither title nor description is present", () => {
    expect(composeProductGroundingPrefix({ identityAnchors: null })).toBe("");
  });

  it("includes the title and product type when both are present", () => {
    const prefix = composeProductGroundingPrefix({ title: "Studio Tote", attributes: { productType: "Handbags" } });
    expect(prefix).toContain("Product: Studio Tote (Handbags).");
  });

  it("includes the title alone when no product type is present", () => {
    const prefix = composeProductGroundingPrefix({ title: "Studio Tote" });
    expect(prefix).toContain("Product: Studio Tote.");
    expect(prefix).not.toContain("(");
  });

  it("includes the description", () => {
    const prefix = composeProductGroundingPrefix({ description: "A handcrafted leather tote." });
    expect(prefix).toContain("A handcrafted leather tote.");
  });

  it("never throws on malformed/unexpected productFacts shapes", () => {
    expect(() => composeProductGroundingPrefix({ title: 123, attributes: "not-an-object" })).not.toThrow();
    expect(composeProductGroundingPrefix({ title: 123, attributes: "not-an-object" })).toBe("");
  });
});

describe("composeProviderPrompt", () => {
  it("prepends the grounding prefix to the creative-direction prompt", () => {
    const prompt = composeProviderPrompt(baseInput({ productFacts: { title: "Studio Tote", attributes: { productType: "Handbags" } } }));
    expect(prompt).toMatch(/^Product: Studio Tote \(Handbags\)\.\s+A red leather handbag/);
  });

  it("appends an Avoid clause for negative constraints", () => {
    const prompt = composeProviderPrompt(baseInput({ creativeDirection: { prompt: "p", negativeConstraints: ["blurry", "watermark"] } }));
    expect(prompt).toMatch(/Avoid: blurry, watermark\.$/);
  });

  it("degrades to just the creative-direction prompt when no grounding data or negative constraints exist", () => {
    const prompt = composeProviderPrompt(baseInput());
    expect(prompt).toBe("A red leather handbag on a marble counter.");
  });
});
