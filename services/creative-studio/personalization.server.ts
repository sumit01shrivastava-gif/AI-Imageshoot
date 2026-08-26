/**
 * Layer 2 of the Creative Studio's creative-intelligence model — a
 * persistent, per-USER, confidence-weighted record of which creative
 * choices (style/lighting/composition/camera/colorDirection) a specific
 * merchant tends to prefer, learned from their own behavior, and applied
 * as a DEFAULT (never a hard override) whenever their current request
 * doesn't specify a value for one of these fields.
 *
 * ## Scope: per-USER, standalone-only — a deliberate choice, not an oversight
 *
 * The codebase's one existing tenant boundary is `shop` (a Workspace's
 * `tenantKey` for standalone, a real myshopify domain for Shopify —
 * see prisma/schema.prisma's `Workspace`/`WorkspaceMembership`). A
 * `Workspace` can have multiple `User`s; a `User` is the standalone
 * auth system's own concept and has NO equivalent on the Shopify side
 * (a Shopify request authenticates via `requireAdminContext`, never
 * resolving a `User.id` at all). Scoping this profile to `userId`
 * (rather than `shop`) was an explicit product decision — it means:
 *   - A Shopify-context Creative Studio session (services/creative-studio/
 *     session.server.ts's `sendCreativeMessage` called with no `userId`)
 *     NEVER reads or writes a profile — there is no user identity to key
 *     one by. This is correct, not a gap: Shopify's own product-identity/
 *     category handling is completely untouched by this module.
 *   - Two different standalone users sharing one workspace get their OWN
 *     separate learned preferences, never each other's.
 *
 * ## Persistence: `PrismaCreativeProfileStore`, real and production-backed
 *
 * `db/repositories/creative-preference.repository.ts` +
 * `prisma/schema.prisma`'s `CreativePreferenceObservation` model back
 * this store in PostgreSQL — the SAME database both Vercel (web) and
 * Railway (worker) already connect to, so a preference learned from a
 * request handled by one process is immediately visible to the other;
 * no in-process cache is ever the source of truth. `InMemoryCreativeProfileStore`
 * still exists and still fully implements `CreativeProfileStore` — kept
 * for fast, DB-free unit tests of the pure confidence/decay/threshold
 * algorithm (see `setConfiguredCreativeProfileStoreForTests`), never
 * used as the resolved default. `getConfiguredCreativeProfileStore()`
 * is the resolver seam: every function in this file depends only on the
 * `CreativeProfileStore` interface, never a concrete implementation.
 *
 * ## The learning model — evidence, confidence, and time decay
 *
 * Every observation of a field/value pair carries a WEIGHT reflecting how
 * reliable that signal is (see `SIGNAL_WEIGHT` below) — explicit feedback
 * ("I like this") is the strongest, an approve/reject decision is
 * weaker, and a same-session "the merchant changed X to Y" correction is
 * the weakest (most inferential) signal.
 *
 * Two independent, deliberately separate numbers are computed at READ
 * time from the persisted `positiveWeight`/`negativeWeight`/
 * `lastObservedAt` (never stored themselves, since both depend on "now"):
 *
 *   - `confidence` = `positiveWeight / (positiveWeight + negativeWeight)`
 *     — an UNDECAYED win-rate ratio. Decaying both terms by the same
 *     factor would cancel out of a ratio entirely, so this number
 *     answers "of the evidence on record, how consistently positive was
 *     it" — a single contradicting signal barely moves it once
 *     substantial positive weight has accumulated, satisfying "one
 *     isolated prompt should NOT permanently redefine preference."
 *   - `decayedWeight` = `(positiveWeight + negativeWeight) * decayFactor(lastObservedAt)`
 *     — an EXPONENTIALLY-DECAYED measure of how much CURRENT evidence
 *     exists (`DECAY_HALF_LIFE_DAYS`-day half-life: a value not
 *     reinforced in that long carries half its raw weight, a quarter
 *     after twice as long, etc.). This is what actually implements "old
 *     preferences decay relative to recent ones": each (field, value)
 *     pair is its OWN row with its OWN `lastObservedAt`, so a value the
 *     merchant hasn't confirmed in months decays toward irrelevance
 *     while a newly/repeatedly-reinforced competing value for the same
 *     field stays fresh — letting the fresher one win the comparison in
 *     `applyLearnedDefaults` even if the stale one has more RAW
 *     historical observations.
 *
 * A learned value is only ever APPLIED once it clears BOTH thresholds —
 * `decayedWeight >= MIN_DECAYED_WEIGHT_TO_APPLY` (enough CURRENT
 * evidence) AND `confidence >= MIN_CONFIDENCE_TO_APPLY` (consistently
 * positive) — see `applyLearnedDefaults`. Candidates that clear both are
 * ranked by `decayedWeight` (most current evidence wins ties).
 *
 * ## Explicit always wins
 *
 * `applyLearnedDefaults` ONLY ever fills in a field that is currently
 * `null`/empty on the parsed intent — it never touches a field the
 * merchant's own current message specified. This is the one
 * non-negotiable rule the whole module exists to serve: personalization
 * is a default layer, never a constraint against the current request.
 *
 * ## Creative Director judgment vs. durable user preference
 *
 * This module has no notion of WHERE a recorded field value came from —
 * whether the merchant typed it, a real LLM's own creative judgment
 * populated it, or personalization itself already filled it in on a
 * prior turn (see creative-brief.ts's "Explicit vs. personalized vs.
 * inferred" for where that distinction actually lives). What this module
 * guarantees instead, regardless of provenance, is that evidence must be
 * SUFFICIENT before it durably changes behavior — mapping onto four
 * conceptual categories: (A) an explicit, stated preference ("I always
 * want X") — not a feature this product currently collects directly, but
 * the highest `SIGNAL_WEIGHT` tier (`explicit`) exists for exactly this;
 * (B) a REPEATEDLY demonstrated behavioral preference — the only
 * category `applyLearnedDefaults` will ever actually apply, since a
 * single review/regenerate/correction observation can never alone clear
 * `MIN_DECAYED_WEIGHT_TO_APPLY`; (C) a one-off Creative Director
 * decision for THIS specific request; (D) a system default necessary for
 * visual quality. (C) and (D) never become durable preferences from a
 * single occurrence — only if the SAME value keeps recurring across
 * genuinely separate approved/reinforced turns (i.e., it has, in effect,
 * become (B)) does it ever get applied.
 *
 * ## Context-aware weighting — a preference is not always one global taste
 *
 * A merchant may genuinely want dark, cinematic imagery for a campaign/
 * lifestyle shot and bright, clean imagery for a plain catalog listing —
 * that is not a contradiction, it is two different, equally valid
 * preferences for two different KINDS of request. Every observation is
 * therefore recorded and retrieved within a coarse `PreferenceContext`
 * bucket (`contextForIntent`, derived from the request's own `intent` —
 * never from free text), and `applyLearnedDefaults` only ever looks at
 * the CURRENT request's own context bucket. There is deliberately NO
 * cross-context fallback: a value that clears the threshold in
 * "campaign" is never offered as a default for a "catalog" request, even
 * if "catalog" has no observations of its own yet. This is what actually
 * prevents "the user rejected one dark catalog photo" or "the user liked
 * one dark campaign photo" from collapsing into a single, wrong,
 * request-type-blind "this user likes dark images" — each bucket only
 * ever reflects evidence gathered within it.
 */
import type { ParsedIntent } from "./intent-schema";
import type { CreativeIntentValue } from "./types";
import {
  listPreferenceObservations,
  upsertPreferenceObservation,
  type PreferenceObservationRow,
} from "../../db/repositories/creative-preference.repository";

/**
 * The coarse creative-request buckets a learned preference is scoped
 * to — see module doc comment's "Context-aware weighting". Deliberately
 * only 2 buckets, not one per `CreativeIntentValue`: the goal is to
 * separate "a plain, accurate catalog listing photo" (where a merchant's
 * campaign-style taste for dark/cinematic/dramatic treatment would
 * actively be WRONG to apply) from everything else, not to build a
 * second, finer-grained taxonomy alongside `CreativeIntentValue`.
 *
 * `"campaign"` is deliberately the DEFAULT for every intent except
 * `CREATE_MARKETPLACE` — including same-image edit/variation intents
 * (`CHANGE_LIGHTING`, `VARIATION`, `REGENERATE`, ...). A same-image edit
 * on its own carries no catalog-vs-campaign signal (e.g. "make it
 * brighter" says nothing about which kind of shoot this is), and the
 * overwhelming majority of real Creative Studio activity is
 * lifestyle/model/social/banner-style content, not plain catalog
 * listings — so defaulting an ambiguous edit to "campaign" is the
 * common-case-correct choice. A known, explicitly-named limitation of
 * this first pass (not silently glossed over): a `CHANGE_LIGHTING`
 * turn that is REALLY refining an ongoing catalog-context session
 * currently gets bucketed as "campaign" rather than inheriting that
 * session's own established context — true session-level context
 * carry-forward (mirroring how `creative-context.ts` already carries
 * `activeSubject`/`activeAction` forward) is a natural next step, not
 * implemented here.
 */
export const PREFERENCE_CONTEXTS = ["campaign", "catalog"] as const;
export type PreferenceContext = (typeof PREFERENCE_CONTEXTS)[number];

const CONTEXT_BY_INTENT: Record<CreativeIntentValue, PreferenceContext> = {
  // Plain, accurate product-listing photography — the one intent with an
  // unambiguous "this must NOT get campaign-style treatment" signal.
  CREATE_MARKETPLACE: "catalog",
  // Everything else defaults to "campaign" — see doc comment above.
  CREATE_LIFESTYLE: "campaign",
  CREATE_SOCIAL: "campaign",
  CREATE_BANNER: "campaign",
  ADD_MODEL: "campaign",
  CHANGE_MODEL: "campaign",
  EDIT_BACKGROUND: "campaign",
  CHANGE_SCENE: "campaign",
  CHANGE_LIGHTING: "campaign",
  CHANGE_CAMERA: "campaign",
  CHANGE_COMPOSITION: "campaign",
  CHANGE_PROPS: "campaign",
  CHANGE_COLOR: "campaign",
  REMOVE_ELEMENT: "campaign",
  ADD_ELEMENT: "campaign",
  UPSCALE: "campaign",
  VARIATION: "campaign",
  MULTI_VARIATION: "campaign",
  REGENERATE: "campaign",
};

/** Derives the preference-context bucket for one request's intent —
 * the ONLY place this mapping is decided (never guessed at a call
 * site). Exported so session.server.ts can derive the same bucket a
 * persisted result's ORIGINATING intent used, for review/feedback
 * signals recorded after the fact. Accepts a plain `string` too (a
 * persisted `GenerationPlan.creativeIntent.intent` is stored as an
 * un-re-validated string — see generation/schema.ts's
 * `CreativeStudioPlanSchema` doc comment) and safely falls back to
 * `"campaign"` (the default bucket above) for anything unrecognized,
 * matching this whole module's "personalization is best-effort, never
 * throws" contract — a genuinely malformed/legacy plan must never turn a
 * working Approve/Reject click into an error. */
export function contextForIntent(intent: string): PreferenceContext {
  return (CONTEXT_BY_INTENT as Record<string, PreferenceContext>)[intent] ?? "campaign";
}

/** The creative fields this module learns from — deliberately a SUBSET
 * of `ParsedIntent`'s full field set. `scene`/`action`/`subject` are
 * request-specific CONTENT (what this particular image is of/where it's
 * set), not stable TASTE — a merchant asking for "beach" today and
 * "temple" tomorrow isn't a preference conflict, it's just two different
 * requests. `style`/`lighting`/`composition`/`camera`/`colorDirection`/
 * `depthOfField` are the fields that plausibly represent a recurring
 * aesthetic preference across otherwise-unrelated requests — a merchant
 * who consistently wants a shallow, blurred-background treatment (or,
 * just as validly, consistently wants everything sharp/deep-focus for
 * accurate catalog listings) is expressing real, stable taste the same
 * way a lighting or composition preference would be. */
export const LEARNABLE_FIELDS = ["style", "lighting", "composition", "camera", "colorDirection", "depthOfField"] as const;
export type LearnableField = (typeof LEARNABLE_FIELDS)[number];

/** How much weight one observation of a given kind carries — see module
 * doc comment's "evidence and confidence" section. Explicit feedback >
 * an approve/reject decision > an inferred same-session correction. */
const SIGNAL_WEIGHT = {
  explicit: 1.0,
  review: 0.6,
  correction: 0.3,
  /** The weakest signal of all — a "pure" regenerate (no new creative
   * direction stated, just "try again") on a result that used a given
   * field value. Deliberately weaker than `correction`: a correction at
   * least names a NEW value the merchant wants instead, real (if
   * inferential) evidence about what they prefer; a bare regenerate only
   * shows the merchant wasn't fully satisfied with what came out, which
   * could be about the field value, the image quality, a rendering
   * artifact, or nothing to do with any structured field at all. See
   * `recordRegenerateSignal`'s own doc comment. */
  regenerate: 0.15,
} as const;
export type SignalSource = keyof typeof SIGNAL_WEIGHT;

/** Roughly 2-3 review-strength signals' worth of CURRENT (undecayed-if-
 * fresh) evidence — see module doc comment's "decayedWeight". */
const MIN_DECAYED_WEIGHT_TO_APPLY = 1.5;
const MIN_CONFIDENCE_TO_APPLY = 0.65;
/** A value not reinforced in this many days carries half its raw
 * accumulated weight; a quarter after twice as long; etc. — see module
 * doc comment's "time decay". Chosen so a preference stays meaningfully
 * "current" across a normal few-weeks-apart usage cadence but a
 * genuinely abandoned one fades within a couple of months. */
const DECAY_HALF_LIFE_DAYS = 30;
/** A learned `style` default never adds more than this many keywords —
 * keeps an applied default from crowding out what the merchant actually
 * asked for elsewhere in the prompt. */
const MAX_APPLIED_STYLE_KEYWORDS = 2;

export interface FieldValueScore {
  positiveWeight: number;
  negativeWeight: number;
  sampleCount: number;
  lastObservedAt: string;
}

export interface CreativeProfile {
  userId: string;
  context: PreferenceContext;
  /** field -> value -> score. A `Record`, not a single "current value"
   * per field, so multi-valued fields (`style`) and "the merchant used
   * to prefer X, now prefers Y" (both tracked, Y's confidence rising as
   * X's stays flat) fall out of the same structure without special
   * -casing either. */
  fields: Record<LearnableField, Record<string, FieldValueScore>>;
}

function emptyProfile(userId: string, context: PreferenceContext): CreativeProfile {
  return {
    userId,
    context,
    fields: { style: {}, lighting: {}, composition: {}, camera: {}, colorDirection: {}, depthOfField: {} },
  };
}

export interface CreativeProfileStore {
  getProfile(userId: string, context: PreferenceContext): Promise<CreativeProfile>;
  /** Records one observation and returns nothing — callers that need
   * the updated profile call `getProfile` again; keeping this
   * fire-and-forget-shaped mirrors how every other "record a usage/
   * audit event" function in this codebase behaves (e.g.
   * services/usage/usage-accounting.server.ts). */
  recordObservation(
    userId: string,
    field: LearnableField,
    value: string,
    signal: "positive" | "negative",
    source: SignalSource,
    context: PreferenceContext,
  ): Promise<void>;
}

/** Fast, DB-free implementation used ONLY by unit tests of the pure
 * algorithm (see `setConfiguredCreativeProfileStoreForTests`) — never
 * the resolved default; see module doc comment's "Persistence" section
 * for the real, production-backed implementation. */
export class InMemoryCreativeProfileStore implements CreativeProfileStore {
  private readonly profiles = new Map<string, CreativeProfile>();

  private key(userId: string, context: PreferenceContext): string {
    return `${userId}::${context}`;
  }

  async getProfile(userId: string, context: PreferenceContext): Promise<CreativeProfile> {
    return this.profiles.get(this.key(userId, context)) ?? emptyProfile(userId, context);
  }

  async recordObservation(
    userId: string,
    field: LearnableField,
    value: string,
    signal: "positive" | "negative",
    source: SignalSource,
    context: PreferenceContext,
  ): Promise<void> {
    const key = this.key(userId, context);
    const profile = this.profiles.get(key) ?? emptyProfile(userId, context);
    const existing = profile.fields[field][value];
    const weight = SIGNAL_WEIGHT[source];
    const next: FieldValueScore = {
      positiveWeight: (existing?.positiveWeight ?? 0) + (signal === "positive" ? weight : 0),
      negativeWeight: (existing?.negativeWeight ?? 0) + (signal === "negative" ? weight : 0),
      sampleCount: (existing?.sampleCount ?? 0) + 1,
      lastObservedAt: new Date().toISOString(),
    };
    profile.fields[field][value] = next;
    this.profiles.set(key, profile);
  }

  /** Test-only: clears every stored profile so one test's observations
   * can't leak into another's assertions — mirrors every other
   * provider's `resetConfiguredXForTests` helper in this codebase. */
  resetForTests(): void {
    this.profiles.clear();
  }
}

function toFieldValueScore(row: PreferenceObservationRow): FieldValueScore {
  return {
    positiveWeight: row.positiveWeight,
    negativeWeight: row.negativeWeight,
    sampleCount: row.sampleCount,
    lastObservedAt: row.lastObservedAt.toISOString(),
  };
}

/** The real, production-backed implementation — see module doc
 * comment's "Persistence" section. Every read/write goes straight
 * through to PostgreSQL (via db/repositories/creative-preference.repository.ts)
 * — no in-process cache, precisely so a preference learned from a
 * request handled by Vercel is immediately visible to a request handled
 * by Railway, and vice versa. */
export class PrismaCreativeProfileStore implements CreativeProfileStore {
  /** Only ever reads THIS context's rows (`listPreferenceObservations`'s
   * own `WHERE context = ...` — see that function's doc comment) — never
   * a cross-context read, by construction. */
  async getProfile(userId: string, context: PreferenceContext): Promise<CreativeProfile> {
    const rows = await listPreferenceObservations(userId, context);
    const profile = emptyProfile(userId, context);
    for (const row of rows) {
      if ((LEARNABLE_FIELDS as readonly string[]).includes(row.field)) {
        profile.fields[row.field as LearnableField][row.value] = toFieldValueScore(row);
      }
    }
    return profile;
  }

  async recordObservation(
    userId: string,
    field: LearnableField,
    value: string,
    signal: "positive" | "negative",
    source: SignalSource,
    context: PreferenceContext,
  ): Promise<void> {
    const weight = SIGNAL_WEIGHT[source];
    await upsertPreferenceObservation(userId, field, value, signal === "positive" ? weight : 0, signal === "negative" ? weight : 0, context);
  }
}

let store: CreativeProfileStore | undefined;

/** The resolver seam — see module doc comment. Resolves to the real,
 * PostgreSQL-backed store in every real request; only a test that
 * explicitly calls `setConfiguredCreativeProfileStoreForTests` (with the
 * in-memory implementation, for a fast pure-logic test) ever sees
 * anything else. */
export function getConfiguredCreativeProfileStore(): CreativeProfileStore {
  if (!store) {
    store = new PrismaCreativeProfileStore();
  }
  return store;
}

/** Test-only: forces a fresh (real, Prisma-backed) store instance —
 * mirrors lib/storage/provider.server.ts's
 * `resetConfiguredStorageProviderForTests`. */
export function resetConfiguredCreativeProfileStoreForTests(): void {
  store = undefined;
}

/** Test-only: injects a specific store implementation — how a unit test
 * that must never touch a real database selects `InMemoryCreativeProfileStore`
 * instead of the resolved (Prisma) default. */
export function setConfiguredCreativeProfileStoreForTests(override: CreativeProfileStore): void {
  store = override;
}

/** Exported (not just for this module's own use) so a test can verify
 * the exact decay curve directly — see module doc comment's "time
 * decay". `now` is injectable so a test never has to actually wait real
 * days to prove decay changes behavior; defaults to the real clock for
 * every production call site. */
export function decayFactor(lastObservedAt: string, now: Date = new Date()): number {
  const ageMs = Math.max(0, now.getTime() - new Date(lastObservedAt).getTime());
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

/** The UNDECAYED win-rate ratio — see module doc comment for why decay
 * deliberately does NOT factor into this number. */
function confidence(score: FieldValueScore | undefined): number {
  if (!score) return 0;
  const total = score.positiveWeight + score.negativeWeight;
  return total > 0 ? score.positiveWeight / total : 0;
}

/** How much CURRENT (recency-decayed) evidence exists for this value —
 * see module doc comment for why this, not raw `sampleCount`, is what
 * actually implements "old preferences decay relative to recent ones". */
function decayedWeight(score: FieldValueScore | undefined, now: Date = new Date()): number {
  if (!score) return 0;
  return (score.positiveWeight + score.negativeWeight) * decayFactor(score.lastObservedAt, now);
}

function clearsApplicationThreshold(score: FieldValueScore | undefined, now: Date = new Date()): boolean {
  return Boolean(score) && decayedWeight(score, now) >= MIN_DECAYED_WEIGHT_TO_APPLY && confidence(score) >= MIN_CONFIDENCE_TO_APPLY;
}

/** The single-value learnable fields — `style` is handled separately
 * below since it's array-valued. */
const SINGLE_VALUE_FIELDS = ["lighting", "composition", "camera", "colorDirection", "depthOfField"] as const satisfies readonly LearnableField[];

/**
 * Fills in whichever of `intent`'s learnable fields are currently
 * `null`/empty with this user's highest-confidence learned value for
 * that field IN THIS REQUEST'S OWN CONTEXT BUCKET (see module doc
 * comment's "Context-aware weighting" — `contextForIntent` derives the
 * bucket from `intent.intent`, never guessed at the call site), when one
 * clears the application threshold. NEVER touches a field the current
 * message already specified — see module doc comment's "Explicit always
 * wins".
 */
export async function applyLearnedDefaults(userId: string, intent: ParsedIntent): Promise<ParsedIntent> {
  const context = contextForIntent(intent.intent);
  const profile = await getConfiguredCreativeProfileStore().getProfile(userId, context);
  let result = intent;

  for (const field of SINGLE_VALUE_FIELDS) {
    if (result[field] !== null) continue; // explicit value present — never overridden
    const candidates = Object.entries(profile.fields[field]).filter(([, score]) => clearsApplicationThreshold(score));
    if (candidates.length === 0) continue;
    candidates.sort(([, a], [, b]) => decayedWeight(b) - decayedWeight(a));
    result = { ...result, [field]: candidates[0][0] };
  }

  if (result.style.length === 0) {
    const candidates = Object.entries(profile.fields.style)
      .filter(([, score]) => clearsApplicationThreshold(score))
      .sort(([, a], [, b]) => confidence(b) - confidence(a))
      .slice(0, MAX_APPLIED_STYLE_KEYWORDS)
      .map(([value]) => value);
    if (candidates.length > 0) {
      result = { ...result, style: candidates };
    }
  }

  return result;
}

/** The subset of a `GenerationPlan.creativeIntent.creative` this module
 * cares about — deliberately loose (`Pick`-shaped, not importing
 * `CreativeStudioPlan` itself) so this file has no dependency on
 * services/generation/, matching CLAUDE.md's domain-boundary rule that
 * creative-studio is the higher-level orchestrator, never the reverse. */
export interface LearnableCreativeFields {
  style: string[];
  lighting: string | null;
  composition: string | null;
  camera: string | null;
  colorDirection: string | null;
  depthOfField: string | null;
}

async function recordFields(
  userId: string,
  fields: LearnableCreativeFields,
  signal: "positive" | "negative",
  source: SignalSource,
  context: PreferenceContext,
): Promise<void> {
  const storeRef = getConfiguredCreativeProfileStore();
  const tasks: Promise<void>[] = [];
  for (const field of SINGLE_VALUE_FIELDS) {
    const value = fields[field];
    if (value) tasks.push(storeRef.recordObservation(userId, field, value, signal, source, context));
  }
  for (const value of fields.style) {
    tasks.push(storeRef.recordObservation(userId, "style", value, signal, source, context));
  }
  await Promise.all(tasks);
}

/** The strongest signal — an explicit "I like this" / "not my style"
 * reaction to a specific result (see app/routes/studio.c.$sessionId.tsx's
 * feedback buttons). Records every learnable field value present on the
 * job that produced the result, into that job's OWN originating
 * `intent`'s context bucket (see session.server.ts's
 * `getLearnableFieldsForResult`, the caller that derives it). */
export async function recordExplicitFeedback(
  userId: string,
  fields: LearnableCreativeFields,
  signal: "positive" | "negative",
  context: PreferenceContext,
): Promise<void> {
  await recordFields(userId, fields, signal, "explicit", context);
}

/** A weaker, but still real, signal — approving or rejecting a result
 * (services/generation/request-generation.server.ts's `reviewGenerationResult`,
 * already-wired to the studio's own Approve/Reject buttons). Approving
 * is a positive vote for that job's creative choices; rejecting is a
 * negative one. */
export async function recordReviewSignal(
  userId: string,
  fields: LearnableCreativeFields,
  decision: "APPROVED" | "REJECTED",
  context: PreferenceContext,
): Promise<void> {
  await recordFields(userId, fields, decision === "APPROVED" ? "positive" : "negative", "review", context);
}

/**
 * The weakest, most inferential signal — a same-session follow-up
 * changed a field's value from what was active before. Records a
 * negative observation for the OLD value and a positive one for the
 * NEW value, for every field that both turns specify and that actually
 * differ (a field going from "specified" to "unspecified" is NOT a
 * correction — the merchant simply didn't mention it this turn, which
 * `activeX` carry-forward already handles correctly on its own).
 * `context` is THIS (the new/current) turn's own context bucket — a
 * correction is evidence about what this user wants for requests LIKE
 * the one they're making right now.
 */
export async function recordCorrectionSignal(
  userId: string,
  previous: LearnableCreativeFields,
  current: LearnableCreativeFields,
  context: PreferenceContext,
): Promise<void> {
  const storeRef = getConfiguredCreativeProfileStore();
  const tasks: Promise<void>[] = [];
  for (const field of SINGLE_VALUE_FIELDS) {
    const prevValue = previous[field];
    const newValue = current[field];
    if (prevValue && newValue && prevValue !== newValue) {
      tasks.push(storeRef.recordObservation(userId, field, prevValue, "negative", "correction", context));
      tasks.push(storeRef.recordObservation(userId, field, newValue, "positive", "correction", context));
    }
  }
  // `style` is multi-valued — treat a keyword dropped between turns as a
  // mild negative, and a newly-added one as a mild positive, rather than
  // an all-or-nothing "the whole array changed" comparison.
  const prevStyle = new Set(previous.style);
  const newStyle = new Set(current.style);
  if (prevStyle.size > 0 && newStyle.size > 0) {
    for (const value of prevStyle) {
      if (!newStyle.has(value)) tasks.push(storeRef.recordObservation(userId, "style", value, "negative", "correction", context));
    }
    for (const value of newStyle) {
      if (!prevStyle.has(value)) tasks.push(storeRef.recordObservation(userId, "style", value, "positive", "correction", context));
    }
  }
  await Promise.all(tasks);
}

/**
 * A "pure" regenerate — the merchant asked to try again WITHOUT stating
 * any new creative direction (session.server.ts only calls this when
 * this turn's own fields are all empty/null — see that call site) — is
 * weak, but real, negative evidence about the PREVIOUS result's active
 * field values. Deliberately distinct from `recordCorrectionSignal`:
 * that function only fires when a field's value actually CHANGED between
 * turns (real evidence of what the merchant wants INSTEAD); this one
 * fires for the complementary case where nothing changed but the
 * merchant still weren't satisfied enough to keep it — there is no "new
 * value" to record a positive signal for, only a weak negative one for
 * what was already there. Per this module's own "do not blindly learn
 * every action" principle (and this feature's explicit product
 * requirement: "do not assume regenerate = dislike everything"), this
 * is deliberately the WEAKEST signal in `SIGNAL_WEIGHT` — a single
 * regenerate can never, on its own, cross `MIN_DECAYED_WEIGHT_TO_APPLY`
 * against an established preference; only a genuinely repeated pattern
 * of regenerating the same field value across separate turns would ever
 * accumulate enough weight to matter.
 */
export async function recordRegenerateSignal(userId: string, activeFields: LearnableCreativeFields, context: PreferenceContext): Promise<void> {
  await recordFields(userId, activeFields, "negative", "regenerate", context);
}
