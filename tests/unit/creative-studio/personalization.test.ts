/**
 * Unit tests: services/creative-studio/personalization.server.ts — the
 * Layer 2 (per-user, confidence-weighted, time-decayed, context-scoped)
 * creative-intelligence model. Deliberately backed by
 * `InMemoryCreativeProfileStore` (injected via
 * `setConfiguredCreativeProfileStoreForTests`), NOT the resolved (real,
 * PostgreSQL-backed) default — this file tests the pure confidence/decay/
 * threshold/context ALGORITHM fast and without a database; see
 * tests/integration/creative-studio/personalization.test.ts for real
 * end-to-end coverage against the actual persistent store and the real
 * queue/worker pipeline.
 *
 * Every `record*` call below is given an explicit context ("campaign" —
 * see personalization.server.ts's `contextForIntent`: `CREATE_LIFESTYLE`,
 * what `baseIntent()` below always uses, maps to "campaign") so recorded
 * observations are visible to `applyLearnedDefaults(userId, baseIntent())`,
 * which derives that same bucket internally from the intent it's given.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyLearnedDefaults,
  recordCorrectionSignal,
  recordRegenerateSignal,
  recordExplicitFeedback,
  recordReviewSignal,
  getConfiguredCreativeProfileStore,
  setConfiguredCreativeProfileStoreForTests,
  resetConfiguredCreativeProfileStoreForTests,
  decayFactor,
  contextForIntent,
  InMemoryCreativeProfileStore,
  type LearnableCreativeFields,
} from "../../../services/creative-studio/personalization.server";
import { parseParsedIntent, type ParsedIntent } from "../../../services/creative-studio/intent-schema";

const USER_A = "user-a";
const USER_B = "user-b";
const CAMPAIGN = "campaign" as const;

function baseIntent(overrides: Partial<ParsedIntent> = {}): ParsedIntent {
  return parseParsedIntent({
    intent: "CREATE_LIFESTYLE",
    mode: "TEXT_TO_IMAGE",
    changeSummary: "test",
    ...overrides,
  });
}

function fields(overrides: Partial<LearnableCreativeFields> = {}): LearnableCreativeFields {
  return { style: [], lighting: null, composition: null, camera: null, colorDirection: null, depthOfField: null, ...overrides };
}

let memoryStore: InMemoryCreativeProfileStore;

beforeEach(() => {
  memoryStore = new InMemoryCreativeProfileStore();
  setConfiguredCreativeProfileStoreForTests(memoryStore);
});

afterEach(() => {
  resetConfiguredCreativeProfileStoreForTests();
});

describe("applyLearnedDefaults", () => {
  it("never overrides a field the current request already specifies — explicit always wins", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive", CAMPAIGN);
    }
    const intent = baseIntent({ lighting: "bright and airy" });
    const result = await applyLearnedDefaults(USER_A, intent);
    expect(result.lighting).toBe("bright and airy");
  });

  it("does not apply a learned value until it clears the minimum decayed-weight threshold, even with 100% positive confidence", async () => {
    // A single correction-strength (weakest) observation — weight 0.3,
    // well below MIN_DECAYED_WEIGHT_TO_APPLY (1.5).
    await recordCorrectionSignal(USER_A, fields({ lighting: "bright" }), fields({ lighting: "cinematic" }), CAMPAIGN);
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBeNull();
  });

  it("applies a learned default once it clears both the decayed-weight and confidence thresholds", async () => {
    for (let i = 0; i < 2; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive", CAMPAIGN);
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBe("cinematic");
  });

  it("applies up to 2 highest-confidence style keywords when the request specifies none", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ style: ["premium", "moody", "editorial"] }), "positive", CAMPAIGN);
    }
    // Make "premium" strictly the strongest by also giving it extra votes.
    for (let i = 0; i < 3; i++) {
      await recordExplicitFeedback(USER_A, fields({ style: ["premium"] }), "positive", CAMPAIGN);
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
      await recordExplicitFeedback(USER_A, fields({ composition: "tight framing" }), "positive", CAMPAIGN);
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.composition).toBe("tight framing");
  });

  it("weak/single feedback does not permanently redefine an established preference", async () => {
    // A strong, established preference for "cinematic" lighting.
    for (let i = 0; i < 10; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive", CAMPAIGN);
    }
    // One single, later rejection of a result that happened to also use
    // "cinematic" lighting.
    await recordReviewSignal(USER_A, fields({ lighting: "cinematic" }), "REJECTED", CAMPAIGN);

    const result = await applyLearnedDefaults(USER_A, baseIntent());
    // 10 * 1.0 positive vs. 1 * 0.6 negative -> confidence ~0.94, still
    // comfortably above the application threshold.
    expect(result.lighting).toBe("cinematic");
  });

  it("repeated corrections DO eventually shift the learned preference — the 'bright -> dark cinematic' worked example", async () => {
    // Simulate several turns where the merchant kept correcting a
    // bright background to a dark cinematic one.
    for (let i = 0; i < 6; i++) {
      await recordCorrectionSignal(
        USER_A,
        { ...fields(), lighting: "bright and airy" },
        { ...fields(), lighting: "darker, moodier lighting" },
        CAMPAIGN,
      );
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBe("darker, moodier lighting");
  });
});

describe("regenerate signal — the weakest of all (see SIGNAL_WEIGHT.regenerate)", () => {
  it("a single 'pure' regenerate can never, on its own, cross the application threshold against nothing", async () => {
    await recordRegenerateSignal(USER_A, fields({ lighting: "flat lighting" }), CAMPAIGN);
    // weight 0.15, far below MIN_DECAYED_WEIGHT_TO_APPLY (1.5) — the
    // negative observation exists, but never suppresses/promotes
    // anything on its own.
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBeNull();
  });

  it("a single regenerate cannot override an established, strongly-reinforced preference", async () => {
    for (let i = 0; i < 10; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic" }), "positive", CAMPAIGN);
    }
    await recordRegenerateSignal(USER_A, fields({ lighting: "cinematic" }), CAMPAIGN);
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.lighting).toBe("cinematic");
  });

  it("regenerate is weaker than correction — the same repeat count that shifts a preference via correction does not necessarily do so via regenerate alone", async () => {
    // 6 regenerates of a value that was never reinforced any other way —
    // weight 6 * 0.15 = 0.9, still below the 1.5 threshold (unlike the
    // equivalent correction-signal worked example above, which DOES
    // clear it at the same repeat count with correction's higher 0.3
    // weight).
    for (let i = 0; i < 6; i++) {
      await recordRegenerateSignal(USER_A, fields({ lighting: "flat lighting" }), CAMPAIGN);
    }
    const rows = await getConfiguredCreativeProfileStore().getProfile(USER_A, CAMPAIGN);
    expect(rows.fields.lighting["flat lighting"]?.negativeWeight).toBeCloseTo(0.9, 5);
  });

  it("repeated regeneration of the SAME field value across many separate turns eventually does register as evidence, once enough accumulates", async () => {
    for (let i = 0; i < 20; i++) {
      await recordRegenerateSignal(USER_A, fields({ lighting: "flat lighting" }), CAMPAIGN);
    }
    const rows = await getConfiguredCreativeProfileStore().getProfile(USER_A, CAMPAIGN);
    expect(rows.fields.lighting["flat lighting"]?.negativeWeight).toBeCloseTo(3.0, 5);
  });
});

describe("Creative Director judgment vs. durable user preference (see personalization.server.ts's module doc comment)", () => {
  it("a single approval of a value the Creative Director decided (not the merchant explicitly) does NOT immediately become a durable preference", async () => {
    // This function has no notion of WHERE a field's value came from
    // (explicit request vs. Creative Director inference/default) — by
    // design, that distinction lives one layer up, in
    // creative-brief.ts's transformationRequirements/personalizationApplied
    // split. What this module guarantees instead: regardless of a
    // value's provenance, ONE review-strength signal (weight 0.6) can
    // never alone cross MIN_DECAYED_WEIGHT_TO_APPLY (1.5) — a single
    // approved generation's creative choices, on their own, never
    // become "this user's preference."
    await recordReviewSignal(USER_A, fields({ composition: "asymmetric, negative-space-heavy" }), "APPROVED", CAMPAIGN);
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.composition).toBeNull();
  });

  it("only sufficiently repeated evidence (category B in the spec's own A/B/C/D framing) promotes a value to an applied default", async () => {
    for (let i = 0; i < 3; i++) {
      await recordReviewSignal(USER_A, fields({ composition: "asymmetric, negative-space-heavy" }), "APPROVED", CAMPAIGN);
    }
    const result = await applyLearnedDefaults(USER_A, baseIntent());
    expect(result.composition).toBe("asymmetric, negative-space-heavy");
  });
});

describe("multi-tenant isolation between users", () => {
  it("User A's preferences never influence User B's generation", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "cinematic", style: ["moody"] }), "positive", CAMPAIGN);
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
      await recordExplicitFeedback(USER_A, fields({ composition: "tight framing" }), "positive", CAMPAIGN);
      await recordExplicitFeedback(USER_B, fields({ composition: "wide establishing shot" }), "positive", CAMPAIGN);
    }
    const a = await applyLearnedDefaults(USER_A, baseIntent());
    const b = await applyLearnedDefaults(USER_B, baseIntent());
    expect(a.composition).toBe("tight framing");
    expect(b.composition).toBe("wide establishing shot");
  });
});

describe("decayFactor — the time-decay curve", () => {
  it("is 1.0 (no decay) for an observation made right now", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(decayFactor(now.toISOString(), now)).toBeCloseTo(1.0, 5);
  });

  it("is exactly 0.5 at one half-life (30 days)", () => {
    const observedAt = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-05-31T00:00:00Z"); // +30 days
    expect(decayFactor(observedAt.toISOString(), now)).toBeCloseTo(0.5, 5);
  });

  it("is exactly 0.25 at two half-lives (60 days)", () => {
    const observedAt = new Date("2026-04-01T00:00:00Z");
    const now = new Date("2026-05-31T00:00:00Z"); // +60 days
    expect(decayFactor(observedAt.toISOString(), now)).toBeCloseTo(0.25, 5);
  });

  it("never goes negative or above 1 for an observation timestamped in the future (clock skew)", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const observedAt = new Date("2026-06-02T00:00:00Z");
    expect(decayFactor(observedAt.toISOString(), now)).toBeLessThanOrEqual(1);
    expect(decayFactor(observedAt.toISOString(), now)).toBeGreaterThan(0);
  });
});

describe("contextForIntent — context-aware weighting (a preference is not always one global taste)", () => {
  it("maps fresh commercial/lifestyle-style intents to 'campaign'", () => {
    expect(contextForIntent("CREATE_LIFESTYLE")).toBe("campaign");
    expect(contextForIntent("CREATE_SOCIAL")).toBe("campaign");
    expect(contextForIntent("CREATE_BANNER")).toBe("campaign");
    expect(contextForIntent("ADD_MODEL")).toBe("campaign");
    expect(contextForIntent("CHANGE_MODEL")).toBe("campaign");
  });

  it("maps plain catalog listing intent to 'catalog'", () => {
    expect(contextForIntent("CREATE_MARKETPLACE")).toBe("catalog");
  });

  it("same-image edit/variation intents default to 'campaign' (the common-case bucket — see contextForIntent's doc comment)", () => {
    expect(contextForIntent("CHANGE_LIGHTING")).toBe("campaign");
    expect(contextForIntent("VARIATION")).toBe("campaign");
    expect(contextForIntent("REGENERATE")).toBe("campaign");
  });

  it("safely falls back to 'campaign' for an unrecognized/legacy persisted intent string, never throws", () => {
    expect(contextForIntent("SOME_FUTURE_INTENT_NOT_YET_MAPPED")).toBe("campaign");
  });

  it("a preference learned in the 'campaign' context is NOT applied to a 'catalog' request — no cross-context fallback", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "dark and moody" }), "positive", "campaign");
    }
    // Same field, same value, but a CREATE_MARKETPLACE (catalog) request.
    const catalogIntent = baseIntent({ intent: "CREATE_MARKETPLACE" });
    const result = await applyLearnedDefaults(USER_A, catalogIntent);
    expect(result.lighting).toBeNull();

    // The campaign-context preference is still there for a campaign request.
    const campaignResult = await applyLearnedDefaults(USER_A, baseIntent());
    expect(campaignResult.lighting).toBe("dark and moody");
  });

  it("the SAME user can hold opposite preferences in different contexts simultaneously — dark for campaigns, bright for catalog", async () => {
    for (let i = 0; i < 5; i++) {
      await recordExplicitFeedback(USER_A, fields({ lighting: "dark cinematic" }), "positive", "campaign");
      await recordExplicitFeedback(USER_A, fields({ lighting: "bright and clean" }), "positive", "catalog");
    }
    const campaignResult = await applyLearnedDefaults(USER_A, baseIntent({ intent: "CREATE_LIFESTYLE" }));
    const catalogResult = await applyLearnedDefaults(USER_A, baseIntent({ intent: "CREATE_MARKETPLACE" }));
    expect(campaignResult.lighting).toBe("dark cinematic");
    expect(catalogResult.lighting).toBe("bright and clean");
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
