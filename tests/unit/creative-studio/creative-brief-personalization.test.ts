/**
 * Unit tests: services/creative-studio/creative-brief.ts's
 * `personalizedFields` handling — the fix for a real, previously
 * -undetected imprecision: before this field existed, a value
 * `applyLearnedDefaults` (personalization.server.ts) filled in was
 * indistinguishable, once it reached `buildCreativeBrief`, from
 * something the merchant actually typed this turn. Deliberately uses
 * generalized, non-repeated fixtures (a bicycle, a wristwatch, a
 * musician) rather than reusing this project's earlier sneaker/yoga/
 * temple examples, to demonstrate the behavior generalizes rather than
 * being special-cased to any one subject.
 */
import { describe, expect, it } from "vitest";
import { buildCreativeBrief, type BuildCreativeBriefInput } from "../../../services/creative-studio/creative-brief";

function baseInput(overrides: Partial<BuildCreativeBriefInput> = {}): BuildCreativeBriefInput {
  return {
    intent: "CREATE_LIFESTYLE",
    subjectPhrase: "the bicycle",
    action: null,
    scene: null,
    style: [],
    lighting: null,
    composition: null,
    camera: null,
    colorDirection: null,
    depthOfField: null,
    addElements: [],
    removeElements: [],
    colorOverride: null,
    materialOverride: null,
    isEditTurn: false,
    preservationRequirements: [],
    ...overrides,
  };
}

describe("buildCreativeBrief — personalizedFields (explicit vs. personalized)", () => {
  it("a field named in personalizedFields moves from transformationRequirements to personalizationApplied", () => {
    const brief = buildCreativeBrief(
      baseInput({
        subjectPhrase: "the wristwatch",
        lighting: "warm golden-hour lighting",
        composition: "45-degree overhead",
        personalizedFields: ["lighting"],
      }),
    );

    // Explicitly requested this turn -> stays in transformationRequirements.
    expect(brief.transformationRequirements).toContain("composition: 45-degree overhead");
    expect(brief.transformationRequirements.some((e) => e.startsWith("lighting:"))).toBe(false);

    // Filled in from this user's own learned preference -> reclassified.
    expect(brief.personalizationApplied).toContain("lighting: warm golden-hour lighting");
  });

  it("with no personalizedFields at all, every entry stays in transformationRequirements (the common, non-personalized case)", () => {
    const brief = buildCreativeBrief(baseInput({ lighting: "soft diffused lighting", camera: "eye-level" }));
    expect(brief.transformationRequirements).toEqual(
      expect.arrayContaining(["lighting: soft diffused lighting", "camera: eye-level"]),
    );
    expect(brief.personalizationApplied).toEqual([]);
  });

  it("action/scene/addElements/removeElements/attribute overrides can NEVER be reclassified as personalized — personalization only ever fills style/lighting/composition/camera/colorDirection", () => {
    const brief = buildCreativeBrief(
      baseInput({
        subjectPhrase: "a street musician",
        action: "playing a violin",
        scene: "a rain-slicked city street at dusk",
        addElements: ["a vintage amplifier"],
        // Deliberately pass every field name as "personalized" to prove
        // the function still refuses to reclassify content fields —
        // this must be a structural guarantee, not merely untested luck.
        personalizedFields: ["action", "scene", "addElements", "removeElements", "colorOverride", "materialOverride"],
      }),
    );
    expect(brief.transformationRequirements).toEqual(
      expect.arrayContaining([
        "pose/action: playing a violin",
        "environment: a rain-slicked city street at dusk",
        "add: a vintage amplifier",
      ]),
    );
    expect(brief.personalizationApplied).toEqual([]);
  });

  it("the composed overallCreativeDirection attributes a personalized value to the user's own usual preference, distinctly from the explicit-transformation clause", () => {
    const brief = buildCreativeBrief(
      baseInput({
        subjectPhrase: "a ceramic mug",
        composition: "tight, close-up framing",
        personalizedFields: ["composition"],
      }),
    );
    expect(brief.overallCreativeDirection).toMatch(/usual preference/i);
    expect(brief.overallCreativeDirection).toMatch(/tight, close-up framing/);
    // The explicit-transformation sentence, if present at all, must not
    // also claim the personalized value as something "the request" said.
    expect(brief.overallCreativeDirection).not.toMatch(/reflects the request:.*tight, close-up framing/i);
  });

  it("a real vendor's own inferred decisions still run against the merged (explicit + personalized) values — inference doesn't care about the source, only priority/attribution does", () => {
    const brief = buildCreativeBrief(
      baseInput({
        subjectPhrase: "a race car",
        intent: "CREATE_BANNER",
        style: ["premium"],
        personalizedFields: ["style"],
      }),
    );
    // Style came from personalization, but the premium-commercial
    // inference rule still fires — a professional creative director
    // doesn't reason differently about lighting/composition quality
    // depending on WHY the shoot is going for a premium look.
    expect(brief.inferredCreativeDecisions.some((d) => /studio-quality/i.test(d))).toBe(true);
    expect(brief.personalizationApplied.some((e) => e.includes("premium"))).toBe(true);
  });
});
