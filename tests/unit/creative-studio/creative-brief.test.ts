/**
 * Unit tests: services/creative-studio/creative-brief.ts — the Creative
 * Director reasoning stage (Part B/E of the creative-intelligence
 * specification). Proves real behavior, not just field presence: the
 * exact "yoga/temple" failure class (Part P) must show up as concrete,
 * assertable structure — not merely somewhere inside a prose paragraph.
 */
import { describe, expect, it } from "vitest";
import { buildCreativeBrief, type BuildCreativeBriefInput } from "../../../services/creative-studio/creative-brief";

function baseInput(overrides: Partial<BuildCreativeBriefInput> = {}): BuildCreativeBriefInput {
  return {
    intent: "CHANGE_SCENE",
    subjectPhrase: "the model",
    action: null,
    scene: null,
    style: [],
    lighting: null,
    composition: null,
    camera: null,
    colorDirection: null,
    addElements: [],
    removeElements: [],
    colorOverride: null,
    materialOverride: null,
    isEditTurn: true,
    preservationRequirements: [],
    ...overrides,
  };
}

describe("buildCreativeBrief — Part P regression: the yoga/temple failure class", () => {
  it(
    "a request naming pose + environment + lighting change produces a brief that structurally demonstrates all three " +
      "transformations, not a prompt collapsed to 'preserve the original image with a dark blurred background'",
    () => {
      const brief = buildCreativeBrief(
        baseInput({
          action: "yoga",
          scene: "a blurred temple in the background",
          lighting: "dark and cinematic",
          composition: "shallow depth of field, subject sharp against a blurred background",
          preservationRequirements: ["category: Person", "identity: recognizable face and body"],
        }),
      );

      // Concrete, assertable evidence — not prose-substring guessing.
      expect(brief.transformationRequirements).toEqual(
        expect.arrayContaining([
          "pose/action: yoga",
          "environment: a blurred temple in the background",
          "lighting: dark and cinematic",
          "composition: shallow depth of field, subject sharp against a blurred background",
        ]),
      );
      expect(brief.preservationRequirements).toEqual(["category: Person", "identity: recognizable face and body"]);
      expect(brief.importantElements).toContain("a blurred temple in the background");
      expect(brief.importantElements).toContain("yoga");

      // The holistic sentence actually mentions the transformation, not
      // just "preserve everything."
      expect(brief.overallCreativeDirection).toMatch(/yoga/);
      expect(brief.overallCreativeDirection).toMatch(/temple/);
      expect(brief.overallCreativeDirection).toMatch(/cinematic/);
      expect(brief.overallCreativeDirection).toMatch(/recognizable/);
    },
  );

  it("the full Part Y worked example produces a brief covering every named creative dimension", () => {
    const brief = buildCreativeBrief(
      baseInput({
        intent: "CREATE_LIFESTYLE",
        subjectPhrase: "the model",
        action: "a natural yoga pose",
        scene: "a dark, atmospheric temple",
        lighting: "cinematic",
        composition: "shallow depth of field",
        style: ["premium", "high-end wellness brand campaign"],
        preservationRequirements: ["identity: recognizable face and body"],
      }),
    );

    expect(brief.transformationRequirements.length).toBeGreaterThanOrEqual(4);
    expect(brief.overallCreativeDirection).toMatch(/wellness|premium/);
    expect(brief.overallCreativeDirection).toMatch(/recognizable/);
  });
});

describe("buildCreativeBrief — inferredCreativeDecisions (explicit vs. inferred)", () => {
  it("a requested pose/action change infers an anatomical-plausibility decision, kept separate from transformationRequirements", () => {
    const brief = buildCreativeBrief(baseInput({ action: "yoga" }));
    expect(brief.transformationRequirements).toEqual(["pose/action: yoga"]);
    expect(brief.inferredCreativeDecisions.some((d) => /anatomically plausible/i.test(d))).toBe(true);
    // The explicit and inferred lists never overlap in content.
    expect(brief.inferredCreativeDecisions).not.toContain("pose/action: yoga");
  });

  it("a requested night scene infers subject/environment lighting coherence (the 'luxury hotel at night' worked example)", () => {
    const brief = buildCreativeBrief(baseInput({ scene: "a luxury hotel at night" }));
    expect(brief.inferredCreativeDecisions.some((d) => /nighttime/i.test(d))).toBe(true);
    expect(brief.inferredCreativeDecisions.some((d) => /coherent photograph/i.test(d))).toBe(true);
  });

  it("'premium' style direction infers studio-quality/commercial-polish decisions (the sneaker-ad worked example)", () => {
    const brief = buildCreativeBrief(baseInput({ style: ["premium"] }));
    expect(brief.inferredCreativeDecisions.some((d) => /studio-quality/i.test(d))).toBe(true);
  });

  it("a fresh commercial/lifestyle intent infers subject-vs-background visual hierarchy", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "CREATE_LIFESTYLE", isEditTurn: false }));
    expect(brief.inferredCreativeDecisions.some((d) => /visually dominant/i.test(d))).toBe(true);
  });

  it("infers nothing when no explicit field conditions any rule — never invents a decision independent of the request", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "UPSCALE" }));
    expect(brief.inferredCreativeDecisions).toEqual([]);
  });

  it("a real vendor's own inferred decisions are used verbatim instead of the deterministic rule table", () => {
    const vendorDecisions = ["A hand-authored, richly-reasoned inference from a real multimodal model."];
    const brief = buildCreativeBrief(baseInput({ action: "yoga", externalInferredCreativeDecisions: vendorDecisions }));
    expect(brief.inferredCreativeDecisions).toEqual(vendorDecisions);
  });

  it("inferred decisions appear in overallCreativeDirection as their own clause, distinct from the explicit-transformation clause", () => {
    const brief = buildCreativeBrief(baseInput({ action: "yoga" }));
    expect(brief.overallCreativeDirection).toMatch(/as the creative director.*anatomically plausible/i);
  });

  it("a real vendor's own overallCreativeDirection is never mixed with the deterministic inferred-decisions sentence", () => {
    const brief = buildCreativeBrief(
      baseInput({ action: "yoga", externalCreativeDirection: "Vendor sentence with no mention of the word plausible." }),
    );
    expect(brief.overallCreativeDirection).toBe("Vendor sentence with no mention of the word plausible.");
    // The deterministic list is still computed/persisted for traceability...
    expect(brief.inferredCreativeDecisions.length).toBeGreaterThan(0);
    // ...but never spliced into the vendor's own sentence.
    expect(brief.overallCreativeDirection).not.toMatch(/anatomically plausible/i);
  });
});

describe("buildCreativeBrief — general behavior", () => {
  it("uses a real vendor-supplied holistic direction when one is provided, instead of the deterministic template", () => {
    const vendorSentence = "A hand-authored, richly-reasoned creative direction from a real multimodal model.";
    const brief = buildCreativeBrief(baseInput({ action: "yoga", externalCreativeDirection: vendorSentence }));
    expect(brief.overallCreativeDirection).toBe(vendorSentence);
  });

  it("falls back to the deterministic composed sentence when no vendor direction is supplied (the heuristic-parser path, always)", () => {
    const brief = buildCreativeBrief(baseInput({ action: "yoga", externalCreativeDirection: null }));
    expect(brief.overallCreativeDirection).not.toBe("");
    expect(brief.overallCreativeDirection).toMatch(/yoga/);
  });

  it("never fabricates a transformation that wasn't requested — an unset dimension produces no entry", () => {
    const brief = buildCreativeBrief(baseInput());
    expect(brief.transformationRequirements).toEqual([]);
    expect(brief.importantElements).toEqual([]);
  });

  it("a creative override (color/material) is represented as a transformation, not silently dropped", () => {
    const brief = buildCreativeBrief(baseInput({ colorOverride: "black", materialOverride: "matte ceramic" }));
    expect(brief.transformationRequirements).toEqual(
      expect.arrayContaining(["product color: black", "product material: matte ceramic"]),
    );
  });

  it("subjectTreatment is derived from a requested action and stays null when no action was requested", () => {
    const withAction = buildCreativeBrief(baseInput({ action: "running" }));
    expect(withAction.subjectTreatment).toMatch(/running/);
    const withoutAction = buildCreativeBrief(baseInput());
    expect(withoutAction.subjectTreatment).toBeNull();
  });

  it("every CreativeIntentValue produces a non-empty creativeObjective (no missing mapping entry)", () => {
    const intents: BuildCreativeBriefInput["intent"][] = [
      "EDIT_BACKGROUND",
      "CHANGE_SCENE",
      "CHANGE_LIGHTING",
      "CHANGE_CAMERA",
      "CHANGE_COMPOSITION",
      "ADD_MODEL",
      "CHANGE_MODEL",
      "CHANGE_PROPS",
      "CHANGE_COLOR",
      "CREATE_LIFESTYLE",
      "CREATE_MARKETPLACE",
      "CREATE_SOCIAL",
      "CREATE_BANNER",
      "REMOVE_ELEMENT",
      "ADD_ELEMENT",
      "UPSCALE",
      "VARIATION",
      "REGENERATE",
      "MULTI_VARIATION",
    ];
    for (const intent of intents) {
      const brief = buildCreativeBrief(baseInput({ intent }));
      expect(brief.creativeObjective.length).toBeGreaterThan(0);
    }
  });
});
