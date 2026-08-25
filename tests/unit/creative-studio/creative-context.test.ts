/**
 * Unit tests: services/creative-studio/creative-context.ts — the compact
 * "creative state" (Part 8) and its stateful reference resolution
 * ("use the second one").
 */
import { describe, expect, it } from "vitest";
import { buildCreativeContext, resolveTargetResult } from "../../../services/creative-studio/creative-context";

describe("buildCreativeContext", () => {
  it("reports no current result and no candidates for a brand-new session", () => {
    const context = buildCreativeContext({
      currentResult: null,
      currentResultCreativeIntent: null,
      latestJobResults: [],
      recentInstructions: [],
    });
    expect(context.hasCurrentResult).toBe(false);
    expect(context.currentImageUrl).toBeNull();
    expect(context.candidateResults).toEqual([]);
  });

  it("carries forward the active scene/style/lighting/composition from the current result's own creative intent", () => {
    const context = buildCreativeContext({
      currentResult: { id: "result-1", url: "https://signed.example/1.png" },
      currentResultCreativeIntent: {
        intent: "CREATE_LIFESTYLE",
        mode: "TEXT_TO_IMAGE",
        creative: {
          subject: "a pair of sneakers",
          action: "yoga",
          scene: "luxury bathroom",
          style: ["premium"],
          lighting: "warm morning sunlight",
          composition: "commercial product advertising",
          camera: null,
          colorDirection: null,
          addElements: [],
          removeElements: [],
          blockedRemovals: [],
        },
        identityConstraints: { immutable: [], instruction: "preserve it" },
        creativeSessionId: "session-1",
        rawInstruction: "put it in a luxury bathroom",
      },
      latestJobResults: [{ id: "result-1", url: "https://signed.example/1.png" }],
      recentInstructions: ["put it in a luxury bathroom"],
    });

    expect(context.hasCurrentResult).toBe(true);
    expect(context.activeSubject).toBe("a pair of sneakers");
    expect(context.activeAction).toBe("yoga");
    expect(context.activeScene).toBe("luxury bathroom");
    expect(context.activeStyle).toEqual(["premium"]);
    expect(context.activeLighting).toBe("warm morning sunlight");
    expect(context.activeComposition).toBe("commercial product advertising");
  });

  it("assigns 1-indexed ordinals to the latest job's results", () => {
    const context = buildCreativeContext({
      currentResult: null,
      currentResultCreativeIntent: null,
      latestJobResults: [
        { id: "a", url: "https://signed.example/a.png" },
        { id: "b", url: "https://signed.example/b.png" },
        { id: "c", url: "https://signed.example/c.png" },
      ],
      recentInstructions: [],
    });
    expect(context.candidateResults).toEqual([
      { id: "a", ordinal: 1, url: "https://signed.example/a.png" },
      { id: "b", ordinal: 2, url: "https://signed.example/b.png" },
      { id: "c", ordinal: 3, url: "https://signed.example/c.png" },
    ]);
  });

  it("bounds previousInstructions to the most recent N (default 5)", () => {
    const instructions = Array.from({ length: 8 }, (_, i) => `instruction ${i + 1}`);
    const context = buildCreativeContext({
      currentResult: null,
      currentResultCreativeIntent: null,
      latestJobResults: [],
      recentInstructions: instructions,
    });
    expect(context.previousInstructions).toEqual(["instruction 4", "instruction 5", "instruction 6", "instruction 7", "instruction 8"]);
  });
});

describe("resolveTargetResult", () => {
  const context = buildCreativeContext({
    currentResult: { id: "b", url: "https://signed.example/b.png" },
    currentResultCreativeIntent: null,
    latestJobResults: [
      { id: "a", url: "https://signed.example/a.png" },
      { id: "b", url: "https://signed.example/b.png" },
      { id: "c", url: "https://signed.example/c.png" },
    ],
    recentInstructions: [],
  });

  it("returns null when there is no reference to resolve", () => {
    expect(resolveTargetResult(context, null)).toBeNull();
  });

  it("returns null when there are no candidates to resolve against", () => {
    const empty = buildCreativeContext({ currentResult: null, currentResultCreativeIntent: null, latestJobResults: [], recentInstructions: [] });
    expect(resolveTargetResult(empty, "second")).toBeNull();
  });

  it("resolves an ordinal word to the matching candidate", () => {
    expect(resolveTargetResult(context, "first")).toBe("a");
    expect(resolveTargetResult(context, "second")).toBe("b");
    expect(resolveTargetResult(context, "third")).toBe("c");
  });

  it("resolves 'last' to the final candidate", () => {
    expect(resolveTargetResult(context, "last")).toBe("c");
  });

  it("resolves 'previous' to the candidate before the currently-selected one", () => {
    // currentResult is "b" (ordinal 2) — "previous" means "a".
    expect(resolveTargetResult(context, "previous")).toBe("a");
  });

  it("resolves 'previous' to the last candidate when nothing is currently selected", () => {
    const noSelection = buildCreativeContext({
      currentResult: null,
      currentResultCreativeIntent: null,
      latestJobResults: [
        { id: "a", url: null },
        { id: "b", url: null },
      ],
      recentInstructions: [],
    });
    expect(resolveTargetResult(noSelection, "previous")).toBe("b");
  });

  it("returns null for an out-of-range ordinal rather than guessing", () => {
    expect(resolveTargetResult(context, "fourth")).toBeNull();
  });
});
