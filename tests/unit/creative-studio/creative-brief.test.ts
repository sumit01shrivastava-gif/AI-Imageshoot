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
    depthOfField: null,
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
  it("requires a new product-derived campaign world for a broad fresh campaign request, not a prettier source scene", () => {
    const brief = buildCreativeBrief(
      baseInput({
        intent: "CREATE_SOCIAL",
        isEditTurn: false,
        subjectPhrase: "the product",
        style: ["exceptional luxury campaign"],
      }),
    );

    expect(brief.campaignSceneTransformation).toBe(true);
    expect(brief.inferredCreativeDecisions.join(" ")).toMatch(/newly conceived campaign world/i);
    expect(brief.inferredCreativeDecisions.join(" ")).toMatch(/incidental source setting, packaging, display/i);
  });

  it("keeps an explicit source-scene preservation/edit request out of campaign-scene replacement", () => {
    const brief = buildCreativeBrief(
      baseInput({
        intent: "CHANGE_LIGHTING",
        isEditTurn: true,
        scene: "the existing presentation box",
        style: ["premium"],
      }),
    );

    expect(brief.campaignSceneTransformation).toBe(false);
    expect(brief.inferredCreativeDecisions.join(" ")).not.toMatch(/newly conceived campaign world/i);
  });

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

  it("a fresh commercial/lifestyle intent infers subject-vs-background visual hierarchy, explicitly covering the model too", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "CREATE_LIFESTYLE", isEditTurn: false }));
    expect(brief.inferredCreativeDecisions.some((d) => /visually dominant/i.test(d))).toBe(true);
    expect(brief.inferredCreativeDecisions.some((d) => /model.*overpower|overpower.*model/i.test(d))).toBe(true);
  });

  it("PRODUCT FIDELITY quality-floor pass: moody/dramatic lighting also infers that product detail must stay readable (Priority 4 must never destroy Priority 1)", () => {
    const brief = buildCreativeBrief(baseInput({ lighting: "dark and cinematic" }));
    expect(brief.inferredCreativeDecisions.some((d) => /crush|blow/i.test(d))).toBe(true);
  });

  it("PRODUCT FIDELITY quality-floor pass — Priority 2: ADD_MODEL infers a category-aware interaction plus human-realism requirements, never a generic 'the model holds the product'", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "ADD_MODEL", category: "Handbags", isEditTurn: false }));
    const decision = brief.inferredCreativeDecisions.find((d) => /holding or wearing it naturally/i.test(d));
    expect(decision).toBeDefined();
    expect(decision).toMatch(/anatomically correct hands/i);
    expect(decision).toMatch(/contact shadows/i);
  });

  it("CHANGE_MODEL also infers the category-aware interaction rule (not just ADD_MODEL)", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "CHANGE_MODEL", category: "Watches" }));
    expect(brief.inferredCreativeDecisions.some((d) => /on the wrist/i.test(d))).toBe(true);
  });

  it("a null/absent category still infers a physically sensible generic interaction for ADD_MODEL, never throwing or guessing 'wearing'", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "ADD_MODEL", category: null }));
    const decision = brief.inferredCreativeDecisions.find((d) => /holding or displaying it naturally/i.test(d));
    expect(decision).toBeDefined();
  });

  it("a non-model intent never infers the model-interaction rule", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "CHANGE_SCENE", scene: "a studio" }));
    expect(brief.inferredCreativeDecisions.some((d) => /anatomically correct hands/i.test(d))).toBe(false);
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

describe("buildCreativeBrief — creativeConcept and negativeCreativeDecisions (Phase 1)", () => {
  it("creativeConcept is null on the deterministic path always — no keyword-table fallback exists for it", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "CREATE_LIFESTYLE", style: ["premium"], scene: "a dark temple" }));
    expect(brief.creativeConcept).toBeNull();
  });

  it("a real vendor's own creativeConcept is used verbatim", () => {
    const concept = "An oversized sculptural desert environment that turns the product into a monumental object.";
    const brief = buildCreativeBrief(baseInput({ externalCreativeConcept: concept }));
    expect(brief.creativeConcept).toBe(concept);
  });

  it("an empty/whitespace-only externalCreativeConcept is treated as absent, not as a real (empty) concept", () => {
    const brief = buildCreativeBrief(baseInput({ externalCreativeConcept: "   " }));
    expect(brief.creativeConcept).toBeNull();
  });

  it("negativeCreativeDecisions applies a context-aware subject-dominance restraint for a fresh creative intent", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "CREATE_LIFESTYLE", isEditTurn: false }));
    expect(brief.negativeCreativeDecisions).toEqual(["Avoid a generic background/environment that competes with or overshadows the subject."]);
  });

  it("adds restraint only when the request makes the failure mode relevant", () => {
    const brief = buildCreativeBrief(
      baseInput({
        intent: "ADD_MODEL",
        category: "Cosmetics",
        lighting: "dark and cinematic",
        depthOfField: "shallow depth of field",
        addElements: ["a single mirror"],
      }),
    );
    expect(brief.negativeCreativeDecisions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/distorted anatomy/i),
        expect.stringMatching(/excessive darkness/i),
        expect.stringMatching(/key detail plane/i),
        expect.stringMatching(/unrequested decorative accessories/i),
        expect.stringMatching(/invented packaging copy/i),
      ]),
    );
  });

  it("negativeCreativeDecisions is empty for a non-fresh (edit) intent with no explicit provider decisions", () => {
    const brief = buildCreativeBrief(baseInput({ intent: "CHANGE_SCENE" }));
    expect(brief.negativeCreativeDecisions).toEqual([]);
  });

  it("a real vendor's own negativeCreativeDecisions are used verbatim instead of the deterministic rule", () => {
    const vendorDecisions = ["generic studio backdrop", "unnecessary decorative props", "competing focal points"];
    const brief = buildCreativeBrief(baseInput({ intent: "CREATE_LIFESTYLE", externalNegativeCreativeDecisions: vendorDecisions }));
    expect(brief.negativeCreativeDecisions).toEqual(vendorDecisions);
  });

  it("negativeCreativeDecisions is never the same list as removeElements — the two concepts stay separate", () => {
    const brief = buildCreativeBrief(
      baseInput({ intent: "CREATE_LIFESTYLE", removeElements: ["the shadow"], externalNegativeCreativeDecisions: ["generic backdrop"] }),
    );
    expect(brief.transformationRequirements).toContain("remove: the shadow");
    expect(brief.negativeCreativeDecisions).toEqual(["generic backdrop"]);
    expect(brief.negativeCreativeDecisions).not.toContain("remove: the shadow");
  });

  it("an explicit scene is never overridden or contradicted by a supplied creativeConcept (marble-table worked example)", () => {
    const brief = buildCreativeBrief(
      baseInput({ scene: "a white marble table", externalCreativeConcept: "A dramatic desert dune landscape." }),
    );
    expect(brief.transformationRequirements).toContain("environment: a white marble table");
    expect(brief.creativeConcept).toBe("A dramatic desert dune landscape.");
  });
});
