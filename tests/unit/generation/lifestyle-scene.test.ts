import { describe, expect, it } from "vitest";
import { buildLifestyleScene } from "../../../services/generation/lifestyle-scene";
import { getBuiltInPreset } from "../../../services/generation/brand-style-presets";

describe("buildLifestyleScene", () => {
  it("falls back to category-aware defaults when no preset/override is given", () => {
    const result = buildLifestyleScene({ categorySignal: "leather handbag", preset: null });

    expect(result.scene.surface).toBe("polished marble");
    expect(result.scene.props).toEqual(["folded scarf", "sunglasses"]);
    expect(result.scene.mood).toBe("sophisticated, aspirational");
    expect(result.scene.colorDirection).toBe("warm neutrals");
    expect(result.environment).toBe("studio");
  });

  it("a preset's attributes override category defaults", () => {
    const preset = getBuiltInPreset("luxury-editorial")!.attributes;
    const result = buildLifestyleScene({ categorySignal: "leather handbag", preset });

    expect(result.scene.surface).toBe("polished marble"); // preset's own value
    expect(result.scene.mood).toBe("elegant, aspirational"); // preset's own value, not the category's
    expect(result.environment).toBe("upscale interior"); // preset's environment, not category's "studio"
    expect(result.photographyStyle).toBe("high-fashion editorial");
  });

  it("a merchant override wins over both preset and category defaults", () => {
    const preset = getBuiltInPreset("luxury-editorial")!.attributes;
    const result = buildLifestyleScene({
      categorySignal: "leather handbag",
      preset,
      override: { environment: "a rooftop garden at sunset", mood: "playful" },
    });

    expect(result.environment).toBe("a rooftop garden at sunset");
    expect(result.scene.mood).toBe("playful");
    expect(result.scene.surface).toBe("polished marble"); // untouched, still the preset's
  });

  it("uses a safe fallback for a category that matches nothing known — never throws", () => {
    const result = buildLifestyleScene({ categorySignal: "completely unknown widget", preset: null });
    expect(result.scene.surface).toBe("neutral surface");
    expect(result.scene.mood).toBe("clean, professional");
  });

  it("negativeConstraints from an override are used verbatim (e.g. deterministic-provider test hooks)", () => {
    const result = buildLifestyleScene({
      categorySignal: "leather handbag",
      preset: null,
      override: { negativeConstraints: ["__GENERATION_TEST_FAIL_ONCE__"] },
    });
    expect(result.negativeConstraints).toEqual(["__GENERATION_TEST_FAIL_ONCE__"]);
  });

  it("scene.sceneType is always populated (environmental, the only treatment this phase's UI offers)", () => {
    const result = buildLifestyleScene({ categorySignal: "leather handbag", preset: null });
    expect(result.scene.sceneType).toBe("environmental");
  });
});
