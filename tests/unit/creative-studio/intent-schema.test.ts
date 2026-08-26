/**
 * Unit tests: services/creative-studio/intent-schema.ts's `parseParsedIntent` —
 * specifically the real production bug this file's `nullishToDefault`
 * fixes. Production evidence: a real OpenAI-backed request
 * (`ai_provider.intent_parse.request`/`.completed` both succeeded) was
 * immediately followed by `studio.new_conversation_failed` /
 * `InvalidParsedIntentError`:
 *
 *   addElements: Invalid input: expected array, received null
 *   removeElements: Invalid input: expected array, received null
 *   preserveHints: Invalid input: expected array, received null
 *   attributeOverrides: Invalid input: expected object, received null
 *
 * i.e. every real-LLM-parsed conversation failed AFTER a successful
 * OpenAI call, before a generation job could ever be created — this is
 * the exact production request shape reproduced here, not a synthetic
 * approximation.
 */
import { describe, expect, it } from "vitest";
import { parseParsedIntent, InvalidParsedIntentError } from "../../../services/creative-studio/intent-schema";

/** The exact minimal shape a real IntentParsingProvider must supply —
 * mirrors what services/ai/openai-intent-parser.server.ts's real OpenAI
 * call returns before validation. */
function minimalValidRaw() {
  return { intent: "CREATE_LIFESTYLE", mode: "TEXT_TO_IMAGE", changeSummary: "test" };
}

describe("parseParsedIntent — null-tolerant array/object fields (real production bug fix)", () => {
  it("the exact production failure: addElements/removeElements/preserveHints/attributeOverrides all returned as literal null no longer throws", () => {
    const raw = {
      ...minimalValidRaw(),
      addElements: null,
      removeElements: null,
      preserveHints: null,
      attributeOverrides: null,
    };
    const result = parseParsedIntent(raw);
    expect(result.addElements).toEqual([]);
    expect(result.removeElements).toEqual([]);
    expect(result.preserveHints).toEqual([]);
    expect(result.attributeOverrides).toEqual({ color: null, material: null });
  });

  it("style and inferredCreativeDecisions (the same vulnerability class, not yet observed in production but structurally identical) also tolerate null", () => {
    const raw = { ...minimalValidRaw(), style: null, inferredCreativeDecisions: null };
    const result = parseParsedIntent(raw);
    expect(result.style).toEqual([]);
    expect(result.inferredCreativeDecisions).toEqual([]);
  });

  it("omitting the fields entirely (undefined) still works exactly as before — the pre-existing, already-correct behavior is preserved", () => {
    const result = parseParsedIntent(minimalValidRaw());
    expect(result.addElements).toEqual([]);
    expect(result.removeElements).toEqual([]);
    expect(result.preserveHints).toEqual([]);
    expect(result.style).toEqual([]);
    expect(result.inferredCreativeDecisions).toEqual([]);
    expect(result.attributeOverrides).toEqual({ color: null, material: null });
  });

  it("a real, non-empty value for these fields still passes through correctly — the fix does not silently discard real content", () => {
    const raw = {
      ...minimalValidRaw(),
      addElements: ["a marble pedestal"],
      removeElements: ["the shadow"],
      preserveHints: ["keep the label exactly as is"],
      style: ["premium", "editorial"],
      inferredCreativeDecisions: ["ensure anatomically plausible pose"],
      attributeOverrides: { color: "black", material: null },
    };
    const result = parseParsedIntent(raw);
    expect(result.addElements).toEqual(["a marble pedestal"]);
    expect(result.removeElements).toEqual(["the shadow"]);
    expect(result.preserveHints).toEqual(["keep the label exactly as is"]);
    expect(result.style).toEqual(["premium", "editorial"]);
    expect(result.inferredCreativeDecisions).toEqual(["ensure anatomically plausible pose"]);
    expect(result.attributeOverrides).toEqual({ color: "black", material: null });
  });

  it("does NOT weaken validation — a genuinely malformed value (wrong type, not null/undefined) still throws InvalidParsedIntentError", () => {
    expect(() => parseParsedIntent({ ...minimalValidRaw(), addElements: "not an array" })).toThrow(InvalidParsedIntentError);
    expect(() => parseParsedIntent({ ...minimalValidRaw(), addElements: [42] })).toThrow(InvalidParsedIntentError);
    expect(() => parseParsedIntent({ ...minimalValidRaw(), attributeOverrides: "not an object" })).toThrow(InvalidParsedIntentError);
    expect(() => parseParsedIntent({ ...minimalValidRaw(), attributeOverrides: { color: 42 } })).toThrow(InvalidParsedIntentError);
  });

  it("still throws InvalidParsedIntentError for a required field that is genuinely missing (not one of the null-tolerant fields)", () => {
    expect(() => parseParsedIntent({ mode: "TEXT_TO_IMAGE", changeSummary: "test" })).toThrow(InvalidParsedIntentError);
  });
});
