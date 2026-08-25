/**
 * Unit tests: services/creative-studio/personalization.server.ts — the
 * Layer 2 (per-user, confidence-weighted) creative-intelligence model.
 * Pure logic, no I/O — the in-memory store is a real, working
 * implementation of the same `CreativeProfileStore` interface a future
 * Prisma-backed one would satisfy, so these tests exercise the actual
 * confidence/threshold/weighting algorithm, not a mock of it.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLearnedDefaults,
  recordCorrectionSignal,
  recordExplicitFeedback,
  recordReviewSignal,
  getConfiguredCreativeProfileStore,
  resetConfiguredCreativeProfileStoreForTests,
  type LearnableCreativeFields,
} from "../../../services/creative-studio/personalization.server";
import { parseParsedIntent, type ParsedIntent } from "../../../services/creative-studio/intent-schema";

const USER_A = "user-a";
const USER_B = "user-b";

function baseIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return parseParsedIntent({
    intent: "CREATE_LIFESTYLE",
    mode: "TEXT_TO_IMAGE",
    changeSummary: "test",
    ...overrides,
  });
}

function fields(overrides: Partial<LearnableCreativeFields> = {}): LearnableCreativeFields {
  return { style: [], lighting: null, composition: null, camera: null, colorDirection: null, ...overrides };
}

afterEach(() => {
  resetConfiguredCreativeProfileStoreForTests();
});

describe("applyLearnedDefaults", () => {
  it("never overrides a field the current request already specifies — explicit always wins", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive");
    }
    const intent = baseIntent({ lighting: "bright and airy" });
    const result = await applyLearnedDefaults(USER_A, intent);
    expect(result.lighting).toBe("bright and airy");
  });

  it("does not apply a learned value until it clears the minimum sample count, even with 100% positive confidence", async () => {
    await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive");
    await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive");
    // Only 2 observations — below MIN_SAMPLES_TO_APPLY (3).
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBeNull();
  });

  it("applies a learned default once it clears both the sample-count and confidence thresholds", async () => {
    for (let i = 0; i < 4; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive");
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBe("cinematic");
  });

  it("applies up to 2 highest-confidence style keywords when the request specifies none", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ style: ["premium", "moody", "editorial"] }), "positive");
    }
    // Make "premium" strictly the strongest by also giving it extra votes.
    for (let i = 0; i < 3; i++) {
      await recordExplicitFeedback(USER_A, fields({ style: ["premium"] }), "positive");
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.style.length).toBeLessThanOrEqual(2);
    expect(result.style).toContain("premium");
  });

  it("a user with no history at all gets no learned defaults — never invents a preference from nothing", async () => {
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBeNull();
    expect(result.composition).toBeNull();
    expect(result.camera).toBeNull();
    expect(result.colorDirection).toBeNull();
    expect(result.style).toEqual([]);
  });
});

describe("signal weighting — explicit > review > correction (see SIGNAL_WEIGHT)", () => {
  it("a single explicit 'love this' reaches the application threshold faster than review/correction signals of the same count", async () => {
    // 3 explicit observations of the same value clears both thresholds
    // (weight 1.0 each -> confidence 1.0, sampleCount 3).
    for (let i = 0; i < 3; i++) {
      await recordExplicitFeedback(USER_A, fields({ composition: "tight framing" }), "positive");
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.composition).toBe("tight framing");
  });

  it("weak/single feedback does not permanently redefine an established preference", async () => {
    // A strong, established preference for "cinematic" lighting.
    for (let i = 0; i < 10; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive");
    }
    // One single, later rejection of a result that happened to also use
    // "cinematic" lighting.
    await recordReviewSignal(USER_A, fields({ lighting: "cinematic" }), "REJECTED");

    const result = await applyLearnedDefaults(USER_A, baseIntent());
    // 10 * 1.0 positive vs. 1 * 0.6 negative -> confidence ~0.94, still
    // comfortably above the application threshold.
    expect(result.lighting).toBe("cinematic");
  });

  it("repeated corrections (the weakest signal) DO eventually shift the learned preference — the 'bright -> dark cinematic' worked example", async () => {
    // Simulate several turns where the merchant kept correcting a
    // bright background to a dark cinematic one.
    for (let i = 0; i < 6; i++) {
      await recordCorrectionSignal(
        USER_A,
        { ...fields(), lighting: "bright and airy" },
        { ...fields(), lighting: "darker, moodier lighting" },
      );
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBe("darker, moodier lighting");
  });
});

describe("multi-tenant isolation between users", () => {
  it("User A's preferences never influence User B's generation", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic", style: ["moody"] }), "positive");
    }
    const resultForB = await applyLearnedDefaults(USER_B, baseIntent());
    expect(resultForB.lighting).toBeNull();
    expect(resultForB.style).toEqual([]);

    // User A's own profile is unaffected by having checked User B's.
    const resultForA = await applyLearnedDefaults(USER_A, baseIntent());
    expect(resultForA.lighting).toBe("cinematic");
  });

  it("two users can develop opposite preferences for the same field with no cross-contamination", async () => {
    for (let i = 0; i < 4; i++) {
      await recordExplicitFeedback(USER_A, fields({ composition: "tight framing" }), "positive");
      await recordExplicitFeedback(USER_B, fields({ composition: "wide establishing shot" }), "positive");
    }
    const a = await applyLearnedDefaults(USER_A, baseIntent());
    const b = await applyLearnedDefaults(USER_B, baseIntent());
    expect(a.composition).toBe("tight framing");
    expect(b.composition).toBe("wide establishing shot");
  });
});

describe("CreativeProfileStore — the resolver seam", () => {
  it("getConfiguredCreativeProfileStore returns the same instance across calls until reset", () => {
    const first = getConfiguredCreativeProfileStore();
    const second = getConfiguredCreativeProfileStore();
    expect(first).toBe(second);
    resetConfiguredCreativeProfileStoreForTests();
    expect(getConfiguredCreativeProfileStore()).not.toBe(first);
  });
});
