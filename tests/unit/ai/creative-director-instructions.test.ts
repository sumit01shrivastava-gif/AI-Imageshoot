/**
 * Unit tests: services/ai/creative-director-instructions.ts — the shared
 * system instruction sent to a real LLM-backed intent parser. These
 * tests exist specifically to enforce this project's own generalization
 * rule (CLAUDE.md / this pass's master rules: "do not hardcode specific
 * products, poses, brands, scenes" and "every solution must generalize
 * to arbitrary users, products, industries, visual styles") — the
 * instruction text itself must never regress into naming a specific
 * worked example.
 */
import { describe, expect, it } from "vitest";
import { CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION } from "../../../services/ai/creative-director-instructions";

describe("CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION", () => {
  it("is a non-trivial, real instruction (not a stub)", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION.length).toBeGreaterThan(500);
  });

  it("names the creative-director role (Phase 3's actual ask)", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/creative director/i);
  });

  it("instructs explicit-vs-inferred separation", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/inferredCreativeDecisions/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/never contradict/i);
  });

  it("instructs reference-image identity-vs-transformation reasoning in general terms", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/identity/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/not a command to preserve the entire original scene/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/presentation box, display case, shipping packaging/i);
  });

  it("requires a product-derived campaign proposition when broad creative freedom is given", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/broad creative freedom/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/deliberate campaign proposition/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/visible form language, materials, color, finish, category/i);
  });

  it("instructs contradiction handling via confidence, not silent guessing", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/conflict|conflicting/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/confidence/i);
  });

  it("instructs the model never to invent a real brand/logo/identifiable person", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/never invent a specific real brand/i);
  });

  it("walks the model through the full A-L internal reasoning framework (Phase 1 of the internal-creative-reasoning upgrade)", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/A\. PURPOSE/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/B\. SUBJECT PRIORITY/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/C\. CONCEPT/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/D\. ENVIRONMENT/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/E\. COMPOSITION/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/F\. CAMERA/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/G\. LIGHT/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/H\. MATERIAL/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/I\. COLOR/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/J\. ATMOSPHERE/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/K\. RESTRAINT/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/L\. COHERENCE/);
  });

  it("instructs the reasoning to stay internal/private — no chain-of-thought is ever returned", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/internally|privately/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/do not write this thinking out|never a transcript of the reasoning/i);
  });

  it("describes creativeConcept as ONE unifying idea, not an adjective list, and documents the marble-table/desert priority example", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/"creativeConcept"/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/premium, dramatic, cinematic.{0,20}is wrong/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/white marble table/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/must never propose replacing the marble table/i);
  });

  it("describes negativeCreativeDecisions as the Creative Director's own restraint judgment, distinct from removeElements", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/"negativeCreativeDecisions"/);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/never a restatement of "removeElements"/i);
  });

  it("never names a specific product, pose, or worked example from this project's own test fixtures", () => {
    const forbidden = [
      "yoga",
      "temple",
      "sneaker",
      "handbag",
      "perfume",
      "wristwatch",
      "bicycle",
      "musician",
      "nike",
      "gucci",
      "chanel",
    ];
    const lower = CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION.toLowerCase();
    for (const term of forbidden) {
      expect(lower).not.toContain(term);
    }
  });
});
