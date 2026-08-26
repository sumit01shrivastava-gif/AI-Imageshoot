/**
 * Structured, validated shape of a parsed conversational instruction —
 * the Creative Studio counterpart to services/intelligence/schema.ts's
 * "reject malformed provider output" gate, applied here to whatever
 * `IntentParsingProvider.parseIntent` (services/ai/types.ts) returns.
 *
 * This is the whole point of Part 3's "structured interpretation layer":
 * a merchant's raw message is NEVER concatenated into a prompt (see
 * docs/creative-studio.md "No arbitrary prompts") — it is first resolved
 * to this validated shape, and the prompt sent to the image provider is
 * synthesized FROM these fields (services/creative-studio/plan-builder.ts),
 * exactly the same "structured fields → synthesized prompt" discipline
 * services/generation/build-plan.ts already applies to every other
 * generationType.
 */
import { z } from "zod";
import { CREATIVE_INTENTS, GENERATION_MODES } from "./types";

export const CreativeIntentSchema = z.enum(CREATIVE_INTENTS);
export const GenerationModeSchema = z.enum(GENERATION_MODES);

/**
 * The structured result of interpreting one merchant message. Every
 * field the intent-parsing layer is allowed to influence — nothing here
 * is ever free text injected verbatim into a provider prompt.
 */
export const ParsedIntentSchema = z.object({
  intent: CreativeIntentSchema,

  /** The parser's own best guess at generation mode — the session-level
   * caller (services/creative-studio/session.server.ts) may still
   * override this (e.g. forcing TEXT_TO_IMAGE when the session has no
   * current result yet, regardless of what the parser guessed). */
  mode: GenerationModeSchema,

  /**
   * The actual noun phrase describing WHAT is being generated — e.g.
   * "a pair of sneakers", "a black perfume bottle" — extracted from a
   * from-scratch request. `.nullable().default(null)` so this is fully
   * backward-compatible: an older/other `IntentParsingProvider`
   * implementation that doesn't know about this field still validates
   * fine (see `parseParsedIntent`), and it's never persisted on its own
   * (only ever folded into a `GenerationPlan` immediately after parsing
   * — see plan-builder.ts) so no migration is needed either way.
   *
   * Only ever meaningful for a STANDALONE (no Shopify product) session
   * — `services/creative-studio/plan-builder.ts`'s
   * `buildStandaloneCreativeGenerationPlan` is the one place this is
   * read; `buildCreativeGenerationPlan` (the Shopify path) never reads
   * it, since a real Shopify product already has a real category/
   * identity to build the prompt's subject from. `null` when the
   * message doesn't describe a new subject (a follow-up edit like "make
   * it brighter," or when extraction found nothing usable) — the
   * standalone plan builder falls back to whatever subject was already
   * established earlier in this session (see creative-context.ts's
   * `activeSubject`), and only as a last resort to a generic
   * placeholder. See docs/creative-studio.md "Standalone subject
   * extraction".
   */
  subject: z.string().min(1).nullable().default(null),

  /**
   * The subject's requested pose/activity — e.g. "yoga", "sitting on a
   * chair" — when the instruction describes one. `null` otherwise.
   *
   * Exists to close a real, structural gap: a reference image's own
   * identity-preservation instruction (see identity-constraints.ts's
   * `buildStandaloneIdentityConstraints`) says "preserved exactly as
   * shown, except for what is explicitly requested below" — before this
   * field existed, a request like "make the model perform yoga" had
   * NOWHERE structured to put "yoga," so it was silently dropped
   * entirely and the model received an instruction that, in effect,
   * preserved the ORIGINAL pose too (identity preservation and pose/
   * composition preservation are different concepts — see
   * docs/creative-studio.md "Preserve vs. transform"). `null`/
   * `.default(null)` — same full backward-compatibility reasoning as
   * `subject` above.
   */
  action: z.string().min(1).nullable().default(null),

  /** e.g. "luxury bathroom", "kitchen countertop" — null when the
   * instruction doesn't describe a scene/environment. */
  scene: z.string().min(1).nullable().default(null),
  /** e.g. ["premium", "skincare advertising"] — descriptive style/mood
   * tokens, not a single free-text sentence. */
  style: z.array(z.string()).default([]),
  /** e.g. "warm morning sunlight". */
  lighting: z.string().min(1).nullable().default(null),
  /** e.g. "commercial product advertising", "45-degree overhead". */
  composition: z.string().min(1).nullable().default(null),
  /** e.g. "eye-level", "close-up macro". */
  camera: z.string().min(1).nullable().default(null),
  /** e.g. "warm and golden", "cool and clean". */
  colorDirection: z.string().min(1).nullable().default(null),
  /** e.g. "shallow depth of field, background softly blurred", "deep
   * focus, everything sharp". A genuinely distinct creative dimension
   * from `composition` (camera framing/angle) — how sharp vs. blurred
   * the space around the subject reads — with nowhere else in this
   * schema to live; `null` when not specified/implied. */
  depthOfField: z.string().min(1).nullable().default(null),

  /** Short noun phrases to add — "a woman holding it", "a marble
   * pedestal" — from ADD_MODEL/ADD_ELEMENT-shaped instructions. */
  addElements: z.array(z.string()).default([]),
  /** Short noun phrases to remove — from REMOVE_ELEMENT instructions. */
  removeElements: z.array(z.string()).default([]),

  /** How many output images this instruction asked for — "give me 3
   * options" → 3. Defaults to 1; capped at the plan schema's own
   * outputCount max (4) by the caller, not here (this schema doesn't
   * import services/generation/schema.ts — see CLAUDE.md's domain
   * boundaries; a plain reasonable ceiling is enforced independently
   * below). */
  variationCount: z.number().int().min(1).max(4).default(1),

  /**
   * An unresolved reference to a PRIOR result this instruction is about
   * — "use the second one", "the first version", "that last one". A raw
   * token (an ordinal word, or null), NOT a resolved GenerationResult id
   * — resolving it against the session's actual candidate results is
   * services/creative-studio/creative-context.ts's job (stateful
   * resolution belongs at the session layer, not inside a stateless
   * parser — see docs/creative-studio.md "Conversational context").
   */
  targetResultReference: z.string().min(1).nullable().default(null),

  /** Structured, machine-checkable preservation hints the parser itself
   * noticed being emphasized ("keep the product exactly the same") —
   * supplementary only. The REAL, non-negotiable preservation set is
   * always derived independently from Product Intelligence's
   * identityAnchors by services/creative-studio/identity-constraints.ts,
   * never from the parser — see docs/creative-studio.md "Identity
   * preservation": a parser (heuristic today, a real model later) must
   * never be the sole thing standing between a request and the product
   * being redesigned. */
  preserveHints: z.array(z.string()).default([]),

  /**
   * The structured "creative override" mechanism (Part 2): explicit,
   * merchant-requested changes to specific NON-CRITICAL product
   * attributes — e.g. "Make the bottle black" → `{ color: "black" }`.
   * Deliberately a narrow, named field set (color/material today), never
   * a free-text override — this is what lets
   * services/creative-studio/identity-constraints.ts distinguish "the
   * merchant explicitly asked to change this one attribute" from "every
   * other attribute must stay exactly as shown," without resorting to
   * fragile string search/replace over the identity instruction text.
   * `null` for each field means "no override requested" — the
   * corresponding identity anchor (if Product Intelligence observed one)
   * stays fully immutable. See docs/creative-studio.md "Creative
   * overrides".
   */
  attributeOverrides: z
    .object({
      color: z.string().min(1).nullable().default(null),
      material: z.string().min(1).nullable().default(null),
    })
    .default({ color: null, material: null }),

  /** One machine-generated sentence summarizing the requested change —
   * used as the seed for prompt synthesis (plan-builder.ts), not sent to
   * the provider verbatim on its own; still entirely built from the
   * structured fields above, never the merchant's raw text. */
  changeSummary: z.string().min(1),

  /** The parser's own confidence, when it has one — 1 for a
   * deterministic/heuristic parser that has no real notion of
   * uncertainty (see services/ai/heuristic-intent-parser.ts's doc
   * comment), a genuine 0–1 score from a future real NLU provider. */
  confidence: z.number().min(0).max(1).default(1),

  /**
   * A real, multimodal-capable parser's OWN holistic creative-director
   * interpretation of this request — e.g. "This is a premium wellness
   * campaign: keep the model recognizable while moving her into a
   * natural yoga pose inside a dark, atmospheric temple, lit cinematically
   * with shallow depth of field." `null` for the heuristic parser
   * (always — it has no such reasoning capability) and for a real
   * provider that didn't supply one; when present, it is preferred over
   * the deterministic template `services/creative-studio/creative-brief.ts`'s
   * `buildCreativeBrief` would otherwise compose from the atomic fields
   * above — see that file's module doc comment. `.nullable().default(null)`,
   * same full backward-compatibility reasoning as `subject`/`action`.
   */
  overallCreativeDirection: z.string().min(1).nullable().default(null),

  /**
   * A real, multimodal-capable parser's OWN inferred creative decisions —
   * what a professional creative director would add to execute the
   * explicit request well, beyond what the merchant literally said (e.g.
   * "ensure anatomically plausible weight distribution for the new
   * pose"). `[]`/absent for the heuristic parser (always — see
   * services/creative-studio/creative-brief.ts's `inferCreativeDecisions`
   * for its own deterministic fallback) and for a real provider that
   * chose not to supply any. `.default([])`, same full
   * backward-compatibility reasoning as `overallCreativeDirection`.
   */
  inferredCreativeDecisions: z.array(z.string()).default([]),
});

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

export class InvalidParsedIntentError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid parsed intent: ${issues.join("; ")}`);
    this.name = "InvalidParsedIntentError";
    this.issues = issues;
  }
}

/** Validates an `IntentParsingProvider`'s raw output — untrusted input,
 * same as any other provider's response (see CLAUDE.md "Reject malformed
 * provider output"). Throws rather than silently coercing. */
export function parseParsedIntent(raw: unknown): ParsedIntent {
  const result = ParsedIntentSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new InvalidParsedIntentError(issues);
  }
  return result.data;
}
