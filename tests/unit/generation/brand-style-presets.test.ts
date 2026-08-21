import { describe, expect, it } from "vitest";
import { BRAND_STYLE_PRESETS, getBuiltInPreset, isBuiltInPresetId } from "../../../services/generation/brand-style-presets";
import { BrandStylePresetAttributesSchema } from "../../../services/generation/schema";

describe("BRAND_STYLE_PRESETS", () => {
  it("has exactly the six named presets from the Phase 5 instructions", () => {
    expect(BRAND_STYLE_PRESETS.map((p) => p.name)).toEqual([
      "Minimal Studio",
      "Luxury Editorial",
      "Natural Lifestyle",
      "Premium Modern",
      "Warm Lifestyle",
      "Clean Commercial",
    ]);
  });

  it("every preset's attributes pass BrandStylePresetAttributesSchema", () => {
    for (const preset of BRAND_STYLE_PRESETS) {
      expect(() => BrandStylePresetAttributesSchema.parse(preset.attributes)).not.toThrow();
    }
  });

  it("every preset has a non-empty id, name, and description", () => {
    for (const preset of BRAND_STYLE_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = BRAND_STYLE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getBuiltInPreset / isBuiltInPresetId", () => {
  it("returns a preset by id", () => {
    const preset = getBuiltInPreset("luxury-editorial");
    expect(preset?.name).toBe("Luxury Editorial");
  });

  it("returns null for an unknown id", () => {
    expect(getBuiltInPreset("does-not-exist")).toBeNull();
  });

  it("isBuiltInPresetId is true only for real built-in ids", () => {
    expect(isBuiltInPresetId("minimal-studio")).toBe(true);
    expect(isBuiltInPresetId("some-custom-preset-id")).toBe(false);
  });
});
