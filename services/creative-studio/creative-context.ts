/**
 * Builds a compact, bounded "creative state" from a session's already
 * -persisted data — the structure Part 8 asks for so short,
 * context-dependent follow-ups ("make it brighter", "use the second
 * one") can be resolved WITHOUT sending the entire raw conversation to
 * the intent parser or the image provider (see
 * docs/creative-studio.md "Conversational context").
 *
 * Pure, no I/O — session.server.ts loads the underlying rows and passes
 * them in already shaped. Nothing here is persisted separately; it's
 * derived fresh on every request from the session's own current state
 * (currentResultId), its latest GenerationJob's plan (for "what's
 * currently active"), and a bounded slice of recent messages — the same
 * "derive, don't duplicate the source of truth" discipline this codebase
 * already applies to batch progress (`groupBy`, never a persisted
 * counter) and staleness detection.
 */
import type { CreativeStudioPlan } from "../generation/schema";

export interface CreativeCandidateResult {
  id: string;
  /** 1-indexed position within the latest generation job's outputs —
   * what "use the second one" refers to. */
  ordinal: number;
  url: string | null;
}

export interface CreativeContext {
  /** Whether a working image already exists for this session — the
   * single signal that decides TEXT_TO_IMAGE vs. every other
   * GenerationMode (see plan-builder.ts). */
  hasCurrentResult: boolean;
  currentImageUrl: string | null;
  selectedResultId: string | null;

  /** The active creative direction, read back from the job that produced
   * the current result — "make it brighter" only changes lighting; scene/
   * style/etc. persist forward until the merchant asks to change them
   * too. `null` fields mean "nothing active to carry forward," not "the
   * merchant asked for nothing." */
  /** The standalone session's own resolved subject from an earlier turn
   * — e.g. "a pair of sneakers" — so a follow-up that doesn't restate it
   * ("make it brighter") still knows what's being depicted. Always
   * `null` for a Shopify-product session (it has a real category
   * instead). See intent-schema.ts's `subject` doc comment. */
  activeSubject: string | null;
  activeScene: string | null;
  activeStyle: string[];
  activeLighting: string | null;
  activeComposition: string | null;

  /** Bounded (see `buildCreativeContext`'s `maxPreviousInstructions`),
   * most-recent-last — light continuity for the parser/assistant replies,
   * never sent to the image provider as prompt text (see
   * docs/creative-studio.md "No arbitrary prompts"). */
  previousInstructions: string[];

  /** The latest generation job's own results, in output order — how
   * "use the second one" / "the first version" gets resolved (see
   * `resolveTargetResult` below). Empty until at least one job has
   * produced results. */
  candidateResults: CreativeCandidateResult[];
}

export interface BuildCreativeContextInput {
  currentResult: { id: string; url: string | null } | null;
  /** The plan of the job that produced `currentResult`, if any — read
   * back for `activeScene`/`activeStyle`/etc. `null` when there's no
   * current result yet, OR when the current result came from a
   * non-CREATIVE_STUDIO generationType (e.g. a session opened via
   * "Continue editing" from an existing LIFESTYLE result) — the plan's
   * shape differs there and isn't recycled into "active creative state"
   * (this session's own instructions, not the prior domain's, are what
   * should drive continuity from that point forward). */
  currentResultCreativeIntent: CreativeStudioPlan | null;
  /** The latest generation job's results, in output order. */
  latestJobResults: Array<{ id: string; url: string | null }>;
  /** Bounded, most-recent-last raw USER message text. */
  recentInstructions: string[];
  maxPreviousInstructions?: number;
}

const DEFAULT_MAX_PREVIOUS_INSTRUCTIONS = 5;

export function buildCreativeContext(input: BuildCreativeContextInput): CreativeContext {
  const max = input.maxPreviousInstructions ?? DEFAULT_MAX_PREVIOUS_INSTRUCTIONS;
  const creative = input.currentResultCreativeIntent?.creative ?? null;

  return {
    hasCurrentResult: input.currentResult !== null,
    currentImageUrl: input.currentResult?.url ?? null,
    selectedResultId: input.currentResult?.id ?? null,

    activeSubject: creative?.subject ?? null,
    activeScene: creative?.scene ?? null,
    activeStyle: creative?.style ?? [],
    activeLighting: creative?.lighting ?? null,
    activeComposition: creative?.composition ?? null,

    previousInstructions: input.recentInstructions.slice(-max),

    candidateResults: input.latestJobResults.map((result, index) => ({
      id: result.id,
      ordinal: index + 1,
      url: result.url,
    })),
  };
}

const ORDINAL_WORD_TO_NUMBER: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
};

/**
 * Resolves a parser-extracted raw ordinal token ("second", "last",
 * "previous") against the actual candidate results — the stateful half
 * of reference resolution the parser itself deliberately doesn't do (see
 * intent-schema.ts's `targetResultReference` doc comment). Returns
 * `null` when there's nothing to resolve against, or the reference
 * doesn't match any real candidate (an out-of-range ordinal, e.g. "the
 * fourth one" when only two exist) — the caller falls back to the
 * session's current result rather than guessing.
 */
export function resolveTargetResult(context: CreativeContext, targetResultReference: string | null): string | null {
  if (!targetResultReference || context.candidateResults.length === 0) return null;

  const token = targetResultReference.toLowerCase();

  if (token === "last") {
    return context.candidateResults[context.candidateResults.length - 1].id;
  }
  if (token === "previous") {
    // "the previous one" means the result before whichever is currently
    // selected — falls back to the last candidate if nothing is
    // currently selected yet.
    const currentIndex = context.candidateResults.findIndex((r) => r.id === context.selectedResultId);
    if (currentIndex > 0) return context.candidateResults[currentIndex - 1].id;
    return context.candidateResults[context.candidateResults.length - 1].id;
  }

  const ordinal = ORDINAL_WORD_TO_NUMBER[token];
  if (!ordinal) return null;
  const match = context.candidateResults.find((r) => r.ordinal === ordinal);
  return match?.id ?? null;
}
