/**
 * Unit tests: services/creative-studio/identity-constraints.ts — Part 4's
 * "the product is the immutable subject" requirement, made structural.
 */
import { describe, expect, it } from "vitest";
import { buildIdentityConstraints } from "../../../services/creative-studio/identity-constraints";
import type { IdentityAnchors } from "../../../services/intelligence/schema";

const FULL_ANCHORS: IdentityAnchors = {
  category: "Handbags",
  shape: "Rectangular",
  material: "Leather",
  primaryColor: "Brown",
  constructionDetails: ["structured body"],
  distinctiveHardware: ["gold clasp"],
  brandingVisible: true,
  brandingDescription: "small embossed logo on the front flap",
};

describe("buildIdentityConstraints", () => {
  it("includes every present anchor in the immutable list", () => {
    const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote");
    expect(result.immutable).toContain("category: Handbags");
    expect(result.immutable).toContain("shape: Rectangular");
    expect(result.immutable).toContain("material: Leather");
    expect(result.immutable).toContain("primary color: Brown");
    expect(result.immutable).toContain("construction: structured body");
    expect(result.immutable).toContain("hardware: gold clasp");
    expect(result.immutable).toContain("branding: small embossed logo on the front flap");
  });

  it("omits anchors Product Intelligence never determined", () => {
    const sparse: IdentityAnchors = {
      category: "Furniture",
      shape: null,
      material: null,
      primaryColor: null,
      constructionDetails: [],
      distinctiveHardware: [],
      brandingVisible: false,
      brandingDescription: null,
    };
    const result = buildIdentityConstraints(sparse, "Oak Chair");
    expect(result.immutable).toEqual(["category: Furniture"]);
  });

  it("asserts visible branding even without a description", () => {
    const anchors: IdentityAnchors = { ...FULL_ANCHORS, brandingDescription: null };
    const result = buildIdentityConstraints(anchors, "Studio Tote");
    expect(result.immutable).toContain("branding: visible, exact branding present");
  });

  it("names the product and explicitly lists geometry/packaging/logos/labels/material/color as protected", () => {
    const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote");
    expect(result.instruction).toContain("Studio Tote");
    expect(result.instruction).toMatch(/immutable subject/i);
    expect(result.instruction).toMatch(/shape and proportions/i);
    expect(result.instruction).toMatch(/packaging/i);
    expect(result.instruction).toMatch(/logos/i);
    expect(result.instruction).toMatch(/labels/i);
    expect(result.instruction).toMatch(/material/i);
    expect(result.instruction).toMatch(/color/i);
    expect(result.instruction).toMatch(/do not redesign/i);
  });

  it("falls back to 'the product' when given an empty product name", () => {
    const result = buildIdentityConstraints(FULL_ANCHORS, "   ");
    expect(result.instruction).toContain("The product is the immutable subject");
  });
});
