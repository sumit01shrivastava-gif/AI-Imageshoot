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
  it("jewelry: wearing on the correct body part", () => {
    expect(resolveProductInteraction("Fine Jewelry")).toMatch(/wearing it naturally on the correct body part/i);
    expect(resolveProductInteraction("Bangles")).toMatch(/wearing it naturally on the correct body part/i);
    expect(resolveProductInteraction("Necklaces")).toMatch(/wearing it naturally on the correct body part/i);
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

  it("an unrecognized category falls back to a physically sensible generic interaction, never 'wearing'", () => {
    const result = resolveProductInteraction("Home Furniture");
    expect(result).toMatch(/holding or displaying it naturally/i);
    expect(result).not.toMatch(/wearing/i);
  });

  it("null category (nothing resolved) falls back to the same generic interaction, never throws", () => {
    expect(() => resolveProductInteraction(null)).not.toThrow();
    expect(resolveProductInteraction(null)).toMatch(/holding or displaying it naturally/i);
  });

  it("matches case-insensitively and as a substring within a longer category label", () => {
    expect(resolveProductInteraction("Fine JEWELRY & Gemstones")).toMatch(/correct body part/i);
  });
});
