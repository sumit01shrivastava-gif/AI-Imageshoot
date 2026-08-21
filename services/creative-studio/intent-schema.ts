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
