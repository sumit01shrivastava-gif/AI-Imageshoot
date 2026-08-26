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
  });

  it("instructs contradiction handling via confidence, not silent guessing", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/conflict|conflicting/i);
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/confidence/i);
  });

  it("instructs the model never to invent a real brand/logo/identifiable person", () => {
    expect(CREATIVE_DIRECTOR_SYSTEM_INSTRUCTION).toMatch(/never invent a specific real brand/i);
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
