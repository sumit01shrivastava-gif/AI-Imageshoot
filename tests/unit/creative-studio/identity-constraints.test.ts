/**
 * Unit tests: services/creative-studio/identity-constraints.ts — Part 4's
 * "the product is the immutable subject" requirement, made structural.
 */
import { describe, expect, it } from "vitest";
import { buildIdentityConstraints, buildStandaloneIdentityConstraints } from "../../../services/creative-studio/identity-constraints";
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

  it("locks the product while treating incidental packaging/source scene as creatively replaceable", () => {
    const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote");
    expect(result.instruction).toContain("Studio Tote");
    expect(result.instruction).toMatch(/immutable subject/i);
    expect(result.instruction).toMatch(/shape and proportions/i);
    expect(result.instruction).toMatch(/presentation box, display case, shipping packaging/i);
    expect(result.instruction).toMatch(/replaceable scene context/i);
    expect(result.instruction).toMatch(/logos/i);
    expect(result.instruction).toMatch(/labels/i);
    expect(result.instruction).toMatch(/material/i);
    expect(result.instruction).toMatch(/color/i);
    expect(result.instruction).toMatch(/do not redesign/i);
  });

  it("PRODUCT FIDELITY quality-floor pass: states the product is the source of truth, not creative inspiration, and covers the expanded fidelity list (geometry/scale, finish/texture, stones/decorative elements, pattern, typography, distinctive features)", () => {
    const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote");
    expect(result.instruction).toMatch(/source of truth/i);
    expect(result.instruction).toMatch(/not creative inspiration/i);
    expect(result.instruction).toMatch(/geometry/i);
    expect(result.instruction).toMatch(/finish/i);
    expect(result.instruction).toMatch(/texture/i);
    expect(result.instruction).toMatch(/stones/i);
    expect(result.instruction).toMatch(/pattern/i);
    expect(result.instruction).toMatch(/typography/i);
    expect(result.instruction).toMatch(/distinctive features/i);
    expect(result.instruction).toMatch(/simplify it/i);
    expect(result.instruction).toMatch(/substitute a visually similar object/i);
  });

  it("falls back to 'the product' when given an empty product name", () => {
    const result = buildIdentityConstraints(FULL_ANCHORS, "   ");
    expect(result.instruction).toContain("The product is the immutable subject");
  });

  describe("creative overrides (Part 2)", () => {
    it("excludes an overridden color from the immutable list", () => {
      const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote", { color: "black" });
      expect(result.immutable).not.toContain("primary color: Brown");
      expect(result.immutable).toContain("material: Leather");
    });

    it("excludes an overridden material from the immutable list", () => {
      const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote", { material: "canvas" });
      expect(result.immutable).not.toContain("material: Leather");
      expect(result.immutable).toContain("primary color: Brown");
    });

    it("records the override structurally on `overridden`", () => {
      const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote", { color: "black" });
      expect(result.overridden).toEqual({ color: "black", material: null });
    });

    it("adds an explicit 'permitted change' clause naming the override, without dropping the rest of the instruction", () => {
      const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote", { color: "black" });
      expect(result.instruction).toMatch(/explicitly requested/i);
      expect(result.instruction).toMatch(/color.*black/i);
      expect(result.instruction).toMatch(/permitted/i);
      // Every other protected item is still asserted.
      expect(result.instruction).toMatch(/shape and proportions/i);
      expect(result.instruction).toMatch(/logos/i);
    });

    it("still preserves color/material when no override is given (unchanged default behavior)", () => {
      const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote");
      expect(result.overridden).toEqual({ color: null, material: null });
      expect(result.instruction).not.toMatch(/merchant has explicitly requested/i);
    });

    it("supports both overrides at once", () => {
      const result = buildIdentityConstraints(FULL_ANCHORS, "Studio Tote", { color: "black", material: "canvas" });
      expect(result.immutable).not.toContain("primary color: Brown");
      expect(result.immutable).not.toContain("material: Leather");
      expect(result.instruction).toMatch(/changes, which are permitted/i);
    });
  });
});

describe("buildStandaloneIdentityConstraints", () => {
  it("never fabricates an immutable list — always empty, with or without a reference image", () => {
    expect(buildStandaloneIdentityConstraints(true).immutable).toEqual([]);
    expect(buildStandaloneIdentityConstraints(false).immutable).toEqual([]);
  });

  it("asserts identity/appearance fidelity when a reference image exists", () => {
    const result = buildStandaloneIdentityConstraints(true);
    expect(result.instruction).toMatch(/uploaded reference image/i);
    expect(result.instruction).toMatch(/identity/i);
    expect(result.instruction).toMatch(/exactly as shown/i);
  });

  // Regression coverage for a real, previously-fixed gap: the old
  // wording said "preserved exactly as shown, except for what is
  // explicitly requested below" — which only worked as well as whatever
  // ended up in a structured field. Pose/action had no field at all
  // before intent-schema.ts's `action` was added, so a reference image
  // implicitly meant "preserve the original pose too," even when the
  // merchant explicitly asked for a different one. The instruction now
  // says, unconditionally, that pose/action/environment/composition are
  // open to reinterpretation — not contingent on every transformation
  // being perfectly captured as its own field first.
  it("explicitly scopes preservation to identity/appearance — pose, action, environment, and composition are open to reinterpretation, not preserved by default", () => {
    const result = buildStandaloneIdentityConstraints(true);
    expect(result.instruction).toMatch(/pose/i);
    expect(result.instruction).toMatch(/action/i);
    expect(result.instruction).toMatch(/environment/i);
    expect(result.instruction).toMatch(/composition/i);
    expect(result.instruction).toMatch(/reinterpreted/i);
  });

  it("states there is nothing to preserve when no reference image exists", () => {
    const result = buildStandaloneIdentityConstraints(false);
    expect(result.instruction).toMatch(/no existing image to preserve/i);
  });

  it("still records a color/material override structurally, same as the Shopify-context path", () => {
    const result = buildStandaloneIdentityConstraints(true, { color: "black" });
    expect(result.overridden).toEqual({ color: "black", material: null });
    expect(result.instruction).toMatch(/explicitly requested/i);
    expect(result.instruction).toMatch(/color.*black/i);
  });
});
