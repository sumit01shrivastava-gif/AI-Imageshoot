/**
 * Unit tests: services/generation/product-interaction.ts —
 * `resolveProductInteraction`, the category-aware model/product
 * interaction resolver (PRODUCT FIDELITY quality-floor pass, Priority 2:
 * correct product/human interaction). Verifies real category coverage
 * generalizes across categories (test-matrix requirement #5 — "Model
 * interaction is category-aware"), not just the jewelry category the
 * production benchmark happened to use, and that an unrecognized/null
 * category never falls back to a wrong "wear it" guess.
 */
import { describe, expect, it } from "vitest";
import { resolveProductInteraction } from "../../../services/generation/product-interaction";

describe("resolveProductInteraction", () => {
  it("jewelry: uses the appropriate body region and visible physical contact", () => {
    expect(resolveProductInteraction("Fine Jewelry")).toMatch(/appropriate body part/i);
    expect(resolveProductInteraction("Bangles")).toMatch(/around the wrist/i);
    expect(resolveProductInteraction("Necklaces")).toMatch(/at the neck/i);
    expect(resolveProductInteraction("Rings")).toMatch(/on a finger/i);
    expect(resolveProductInteraction("Bangles")).toMatch(/clearly visible.*natural contact.*occlusion/i);
  });

  it("eyewear: worn on the face", () => {
    expect(resolveProductInteraction("Sunglasses")).toMatch(/on the face/i);
  });

  it("watches: worn on the wrist", () => {
    expect(resolveProductInteraction("Watches")).toMatch(/on the wrist/i);
  });

  it("footwear: worn on the foot", () => {
    expect(resolveProductInteraction("Footwear")).toMatch(/on the foot/i);
  });

  it("clothing: worn on the body", () => {
    expect(resolveProductInteraction("Apparel")).toMatch(/on the body/i);
  });

  it("bags: held or worn as actually carried", () => {
    expect(resolveProductInteraction("Handbags")).toMatch(/holding or wearing it naturally/i);
  });

  it("beauty/skincare: held, applied, or displayed as actually used", () => {
    expect(resolveProductInteraction("Skincare")).toMatch(/holding, applying, or displaying/i);
  });

  it("electronics: held or operated naturally", () => {
    expect(resolveProductInteraction("Electronics")).toMatch(/holding or using it naturally/i);
  });

  it("food/beverage: held, poured, or served as actually presented", () => {
    expect(resolveProductInteraction("Beverages")).toMatch(/holding, pouring, or serving/i);
  });

  it("home/lifestyle products avoid forced human contact when it is not commercially natural", () => {
    const result = resolveProductInteraction("Home Furniture");
    expect(result).toMatch(/only where physically and commercially natural/i);
    expect(result).not.toMatch(/wearing/i);
  });

  it("null category (nothing resolved) falls back to the same generic interaction, never throws", () => {
    expect(() => resolveProductInteraction(null)).not.toThrow();
    expect(resolveProductInteraction(null)).toMatch(/holding or displaying it naturally/i);
  });

  it("matches case-insensitively and as a substring within a longer category label", () => {
    expect(resolveProductInteraction("Fine JEWELRY & Gemstones")).toMatch(/appropriate body part/i);
  });

  it("preserves an explicit merchant interaction over the category default", () => {
    const result = resolveProductInteraction("Bangles", "holding the bangles in an open hand");
    expect(result).toMatch(/explicitly requested holding the bangles in an open hand/i);
    expect(result).not.toMatch(/around the wrist/i);
    expect(result).toMatch(/real-world scale.*occlusion/i);
  });
});
