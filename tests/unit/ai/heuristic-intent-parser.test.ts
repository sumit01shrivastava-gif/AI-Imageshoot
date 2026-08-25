/**
 * Unit tests: services/ai/heuristic-intent-parser.ts — the always-on
 * rule-based `IntentParsingProvider` default. Verifies the taxonomy
 * classification, structured field extraction, and mode inference the
 * rest of the Creative Studio pipeline depends on.
 */
import { describe, expect, it } from "vitest";
import { HeuristicIntentParser } from "../../../services/ai/heuristic-intent-parser";
import { parseParsedIntent } from "../../../services/creative-studio/intent-schema";

const parser = new HeuristicIntentParser();

async function parse(message: string, candidateResultCount = 0) {
  const raw = await parser.parseIntent({ message, creativeContext: {}, candidateResultCount });
  return parseParsedIntent(raw);
}

describe("HeuristicIntentParser", () => {
  it("has a stable, honest name (not implying a real AI vendor)", () => {
    expect(parser.name).toBe("heuristic");
  });

  it("parses the Part 3 example into structured scene/style/lighting/composition", async () => {
    const result = await parse("Make it look like a premium skincare advertisement in a luxury bathroom with warm morning sunlight.");

    expect(result.scene).toBe("luxury bathroom");
    expect(result.style).toContain("premium");
    expect(result.lighting).toMatch(/sunlight|morning/i);
    expect(result.composition).toBe("commercial product advertising");
    // No prior result exists yet — this is a fresh scene.
    expect(result.mode).toBe("TEXT_TO_IMAGE");
  });

  describe("subject extraction (standalone Creative Studio — see intent-schema.ts's `subject` doc comment)", () => {
    // The exact real production request this pass fixes: previously
    // "sneakers"/"beach"/"cloudy" were all lost before the request ever
    // reached OpenAI, which then generated an unrelated generic product
    // image. See plan-builder.ts's `buildStandaloneCreativeGenerationPlan`.
    it("preserves 'pair of sneakers' from the real production request that previously collapsed to 'product'", async () => {
      const result = await parse("Please create a image for pair of sneakers at beach with cloudy background");
      expect(result.subject).toBe("pair of sneakers");
      // Also the second part of the same production bug — an article
      // -less scene phrase ("at beach", not "at the beach") must still
      // be captured.
      expect(result.scene).toBe("beach");
    });

    it("extracts a subject from a generic, non-sneaker-specific request — proves this isn't hardcoded to one example", async () => {
      const result = await parse("Generate a luxury black perfume bottle on a marble table");
      expect(result.subject).toBe("black perfume bottle");
      expect(result.scene).toBe("marble table");
    });

    it("extracts a subject with no leading style keyword and a filler 'image' word stripped", async () => {
      const result = await parse("Create a premium sneaker image on a beach with a cloudy background");
      expect(result.subject).toBe("sneaker");
    });

    it("extracts a subject from 'Make a product photo of X in Y' phrasing", async () => {
      const result = await parse("Make a product photo of a white ceramic coffee mug in a cozy kitchen");
      expect(result.subject).toBe("white ceramic coffee mug");
    });

    it("returns null, never a bare pronoun, for a follow-up edit with no restated subject", async () => {
      const result = await parse("Make it brighter", 1);
      expect(result.subject).toBeNull();
    });

    it("returns null when the message has no recognizable subject at all", async () => {
      const result = await parse("Regenerate this");
      expect(result.subject).toBeNull();
    });
  });

  describe("action/pose extraction (see intent-schema.ts's `action` doc comment — the real 'yoga' production case)", () => {
    // The exact scenario this pass was built for: a reference image
    // should not implicitly mean "keep the original pose." Verifies the
    // GENERALIZED verb-triggered extractor, not a yoga-specific rule.
    it("extracts 'yoga' from the real worked example ('perform yoga')", async () => {
      const result = await parse(
        "Make the model perform yoga with a blurred temple in the background and make the background dark.",
        1,
      );
      expect(result.action).toBe("yoga");
    });

    it("generalizes to an unrelated activity — proves this isn't hardcoded to yoga", async () => {
      const result = await parse("Have him doing a handstand on the beach", 1);
      expect(result.action).toBe("a handstand");
    });

    it("extracts a base-verb 'practice' phrasing", async () => {
      const result = await parse("Make her practice meditation by a waterfall", 1);
      expect(result.action).toBe("meditation");
    });

    it("falls back to the gerund-after-referent form when no trigger verb is present", async () => {
      const result = await parse("Show her dancing under the city lights", 1);
      expect(result.action).toBe("dancing under the city lights");
    });

    it("returns null when the message describes no pose/activity at all", async () => {
      const result = await parse("Make the background darker", 1);
      expect(result.action).toBeNull();
    });
  });

  describe("lighting extraction — bare 'dark'/'bright', not only their comparative forms", () => {
    it("recognizes a bare 'dark' request (previously only 'darker' matched)", async () => {
      const result = await parse("make the background dark", 1);
      expect(result.lighting).toBe("darker, moodier lighting");
      expect(result.intent).toBe("CHANGE_LIGHTING");
    });

    it("recognizes a bare 'bright' request", async () => {
      const result = await parse("make it bright", 1);
      expect(result.lighting).toBe("brighter lighting");
    });
  });

  describe("clothing-change extraction (generalized 'change X to Y' for a bounded, common set of garment nouns)", () => {
    it("captures a requested clothing change as an addElement", async () => {
      const result = await parse("Change her dress to a red evening gown", 1);
      expect(result.addElements).toContain("wearing a red evening gown");
    });

    it("generalizes to a different garment noun — proves this isn't hardcoded to 'dress'", async () => {
      const result = await parse("Turn his outfit into a black tuxedo", 1);
      expect(result.addElements).toContain("wearing a black tuxedo");
    });
  });

  describe("multiple simultaneous transformations in one message", () => {
    it("extracts action + scene + clothing + lighting all at once, none overwriting another", async () => {
      const result = await parse(
        "Make the model perform yoga on a beach and change her dress to a red evening gown, with warm golden lighting",
        1,
      );
      expect(result.action).toBe("yoga");
      expect(result.scene).toBe("beach");
      expect(result.addElements).toContain("wearing a red evening gown");
      expect(result.lighting).toBe("warm golden lighting");
    });
  });

  describe("explicit preservation instructions", () => {
    it("'keep everything the same but make the background darker' only changes lighting — no spurious subject/action/scene extracted", async () => {
      const result = await parse("Keep everything the same but make the background darker", 1);
      expect(result.lighting).toMatch(/darker/i);
      expect(result.subject).toBeNull();
      expect(result.action).toBeNull();
      expect(result.scene).toBeNull();
    });
  });

  it("classifies 'put my product in a premium lifestyle scene' as CREATE_LIFESTYLE", async () => {
    const result = await parse("Put my product in a premium lifestyle scene");
    expect(result.intent).toBe("CREATE_LIFESTYLE");
    expect(result.style).toContain("premium");
  });

  it("classifies a clean marketplace-style request as CREATE_MARKETPLACE", async () => {
    const result = await parse("Create a clean Amazon-style product image");
    expect(result.intent).toBe("CREATE_MARKETPLACE");
  });

  it("classifies a background change as EDIT_BACKGROUND with the scene extracted", async () => {
    const result = await parse("Change the background to a luxury marble bathroom");
    expect(result.intent).toBe("EDIT_BACKGROUND");
    expect(result.scene).toBe("luxury marble bathroom");
  });

  it("classifies 'add a model holding it' as ADD_MODEL and records a preserve hint when asked to keep the product the same", async () => {
    const result = await parse("Keep the product exactly the same and add a model holding it");
    expect(result.intent).toBe("ADD_MODEL");
    expect(result.addElements).toContain("a model holding the product");
    expect(result.preserveHints).toContain("product identity");
  });

  it("infers IMAGE_EDIT mode for ADD_MODEL when a current result already exists", async () => {
    const result = await parse("add a model holding it", 1);
    expect(result.mode).toBe("IMAGE_EDIT");
  });

  it("extracts an explicit variation count and classifies MULTI_VARIATION", async () => {
    const result = await parse("Create 3 variations");
    expect(result.intent).toBe("MULTI_VARIATION");
    expect(result.variationCount).toBe(3);
  });

  it("extracts a word-form variation count", async () => {
    const result = await parse("Give me four options");
    expect(result.variationCount).toBe(4);
  });

  it("caps variation count at 4 even if a larger number is requested", async () => {
    const result = await parse("Give me 10 variations");
    expect(result.variationCount).toBe(4);
  });

  it("classifies a plain follow-up as VARIATION when a current result exists", async () => {
    const result = await parse("Give me another version", 1);
    expect(result.intent).toBe("VARIATION");
    expect(result.mode).toBe("VARIATION");
  });

  // Part 4 worked example: "keep everything the same but make it premium"
  // must produce an image-EDIT instruction (working forward from the
  // existing result) rather than being miscategorized as an unrelated
  // fresh TEXT_TO_IMAGE generation.
  it("classifies 'keep everything the same but make it premium' as an edit (VARIATION mode) when a current result exists, carrying the style forward", async () => {
    const result = await parse("Keep everything the same but make it premium", 1);
    expect(result.mode).toBe("VARIATION");
    expect(result.style).toContain("premium");
  });

  it("classifies 'make it brighter' as CHANGE_LIGHTING with a lighting phrase", async () => {
    const result = await parse("Make it brighter", 1);
    expect(result.intent).toBe("CHANGE_LIGHTING");
    expect(result.lighting).toBe("brighter lighting");
    expect(result.mode).toBe("IMAGE_TO_IMAGE");
  });

  it("extracts an ordinal reference for 'use the second one'", async () => {
    const result = await parse("Use the second one", 3);
    expect(result.targetResultReference).toBe("second");
  });

  // Part 4 worked example: "use the second image" — the noun after the
  // ordinal varies ("one"/"version"/"image"/...); the ordinal word itself
  // is the only thing that matters for resolution (see
  // creative-context.ts's `resolveTargetResult`).
  it("extracts an ordinal reference for 'use the second image' (a noun ORDINAL_PATTERN's optional group doesn't list)", async () => {
    const result = await parse("Use the second image", 3);
    expect(result.targetResultReference).toBe("second");
  });

  it("extracts a remove-element instruction", async () => {
    const result = await parse("Remove the shadow", 1);
    expect(result.intent).toBe("REMOVE_ELEMENT");
    expect(result.removeElements).toContain("shadow");
  });

  it("classifies 'regenerate this' as REGENERATE", async () => {
    const result = await parse("Regenerate this", 1);
    expect(result.intent).toBe("REGENERATE");
    expect(result.mode).toBe("VARIATION");
  });

  it("falls back to TEXT_TO_IMAGE mode when there is no current result, regardless of intent", async () => {
    const result = await parse("Make it brighter", 0);
    expect(result.mode).toBe("TEXT_TO_IMAGE");
  });

  it("never leaves changeSummary empty — always produces a machine-generated summary, never the raw message", async () => {
    const message = "asdkfj random gibberish with no recognizable pattern";
    const result = await parse(message);
    expect(result.changeSummary.length).toBeGreaterThan(0);
    expect(result.changeSummary).not.toBe(message);
  });

  it("always resolves to one of the fixed taxonomy values, never an arbitrary string", async () => {
    const result = await parse("supercalifragilisticexpialidocious");
    expect(result.intent).toBeTruthy();
    // Validated by parseParsedIntent already (would have thrown
    // otherwise) — this assertion just documents the guarantee.
  });

  describe("attributeOverrides (Part 2's creative-override mechanism)", () => {
    it("extracts an explicit color override from 'Make the bottle black'", async () => {
      const result = await parse("Make the bottle black");
      expect(result.attributeOverrides.color).toBe("black");
      expect(result.attributeOverrides.material).toBeNull();
      expect(result.intent).toBe("CHANGE_COLOR");
    });

    it("extracts an explicit color override from 'Make it red'", async () => {
      const result = await parse("Make it red");
      expect(result.attributeOverrides.color).toBe("red");
    });

    it("extracts an explicit material override from 'Make it out of wood'", async () => {
      const result = await parse("Make it out of wood");
      expect(result.attributeOverrides.material).toBe("wood");
      expect(result.attributeOverrides.color).toBeNull();
    });

    it("extracts a material override phrased with 'in'", async () => {
      const result = await parse("Make the chair in oak");
      expect(result.attributeOverrides.material).toBe("oak");
    });

    it("leaves both overrides null for a message that doesn't request one", async () => {
      const result = await parse("Put it in a luxury bathroom");
      expect(result.attributeOverrides).toEqual({ color: null, material: null });
    });

    // Part 4 worked example: a genuine gap found during the final
    // production-integration audit — the original pattern only matched
    // "make it/the X [color]" and missed "turn X into Y" phrasing
    // entirely, so this message fell through every classifier rule to
    // the generic VARIATION/CREATE_LIFESTYLE default instead of being
    // recognized as a color override at all.
    it("extracts the TARGET color (not the product's current color) from 'Turn this red bottle into a blue bottle'", async () => {
      const result = await parse("Turn this red bottle into a blue bottle");
      expect(result.attributeOverrides.color).toBe("blue");
      expect(result.intent).toBe("CHANGE_COLOR");
    });

    it("extracts a color override from 'change it to blue' ('to' phrasing, no 'into')", async () => {
      const result = await parse("change it to blue");
      expect(result.attributeOverrides.color).toBe("blue");
    });

    it("extracts a color override from 'turn the bottle blue' (direct-object form with 'turn')", async () => {
      const result = await parse("turn the bottle blue");
      expect(result.attributeOverrides.color).toBe("blue");
    });
  });
});
