import { describe, expect, it } from "vitest";
import { recordIdentityValidation } from "../../../services/generation/identity-validation.server";
import type { IdentityAnchors } from "../../../services/intelligence/schema";

function anchors(overrides: Partial<IdentityAnchors> = {}): IdentityAnchors {
  return {
    category: "Handbags",
    shape: null,
    material: null,
    primaryColor: null,
    constructionDetails: [],
    distinctiveHardware: [],
    brandingVisible: false,
    brandingDescription: null,
    ...overrides,
  };
}

describe("recordIdentityValidation", () => {
  it("always reports validated: false — no vision-capable provider is configured in this codebase", () => {
    const result = recordIdentityValidation(anchors());
    expect(result.validated).toBe(false);
    expect(result.reason).toBe("no vision-capable provider configured");
  });

  it("category is always in identityAnchorsChecked (mandatory, never null)", () => {
    const result = recordIdentityValidation(anchors());
    expect(result.identityAnchorsChecked).toContain("category");
  });

  it("only includes optional anchor fields that were actually present", () => {
    const result = recordIdentityValidation(
      anchors({ shape: "Rectangular", material: "Leather", primaryColor: null }),
    );
    expect(result.identityAnchorsChecked).toEqual(expect.arrayContaining(["category", "shape", "material"]));
    expect(result.identityAnchorsChecked).not.toContain("primaryColor");
  });

  it("includes both brandingVisible and brandingDescription only when branding is visible", () => {
    const withBranding = recordIdentityValidation(anchors({ brandingVisible: true, brandingDescription: "Embossed logo" }));
    expect(withBranding.identityAnchorsChecked).toEqual(
      expect.arrayContaining(["brandingVisible", "brandingDescription"]),
    );

    const withoutBranding = recordIdentityValidation(anchors({ brandingVisible: false }));
    expect(withoutBranding.identityAnchorsChecked).not.toContain("brandingVisible");
    expect(withoutBranding.identityAnchorsChecked).not.toContain("brandingDescription");
  });

  it("includes constructionDetails/distinctiveHardware only when non-empty", () => {
    const withDetails = recordIdentityValidation(
      anchors({ constructionDetails: ["structured body"], distinctiveHardware: ["gold zipper"] }),
    );
    expect(withDetails.identityAnchorsChecked).toEqual(
      expect.arrayContaining(["constructionDetails", "distinctiveHardware"]),
    );

    const withoutDetails = recordIdentityValidation(anchors());
    expect(withoutDetails.identityAnchorsChecked).not.toContain("constructionDetails");
    expect(withoutDetails.identityAnchorsChecked).not.toContain("distinctiveHardware");
  });
});
