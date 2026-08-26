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
 */
import type { ParsedIntent } from "./intent-schema";
import {
  listPreferenceObservations,
  upsertPreferenceObservation,
  type PreferenceObservationRow,
} from "../../db/repositories/creative-preference.repository";

/** The creative fields this module learns from — deliberately a SUBSET
 * of `ParsedIntent`'s full field set. `scene`/`action`/`subject` are
 * request-specific CONTENT (what this particular image is of/where it's
 * set), not stable TASTE — a merchant asking for "beach" today and
 * "temple" tomorrow isn't a preference conflict, it's just two different
 * requests. `style`/`lighting`/`composition`/`camera`/`colorDirection`
 * are the fields that plausibly represent a recurring aesthetic
 * preference across otherwise-unrelated requests. */
export const LEARNABLE_FIELDS = ["style", "lighting", "composition", "camera", "colorDirection"] as const;
export type LearnableField = (typeof LEARNABLE_FIELDS)[number];

/** How much weight one observation of a given kind carries — see module
 * doc comment's "evidence and confidence" section. Explicit feedback >
 * an approve/reject decision > an inferred same-session correction. */
const SIGNAL_WEIGHT = {
  explicit: 1.0,
  review: 0.6,
  correction: 0.3,
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
  /** field -> value -> score. A `Record`, not a single "current value"
   * per field, so multi-valued fields (`style`) and "the merchant used
   * to prefer X, now prefers Y" (both tracked, Y's confidence rising as
   * X's stays flat) fall out of the same structure without special
   * -casing either. */
  fields: Record<LearnableField, Record<string, FieldValueScore>>;
}

function emptyProfile(userId: string): CreativeProfile {
  return {
    userId,
    fields: { style: {}, lighting: {}, composition: {}, camera: {}, colorDirection: {} },
  };
}

export interface CreativeProfileStore {
  getProfile(userId: string): Promise<CreativeProfile>;
  /** Records one observation and returns nothing — callers that need
   * the updated profile call `getProfile` again; keeping this
   * fire-and-forget-shaped mirrors how every other "record a usage/
   * audit event" function in this codebase behaves (e.g.
   * services/usage/usage-accounting.server.ts). */
  recordObservation(userId: string, field: LearnableField, value: string, signal: "positive" | "negative", source: SignalSource): Promise<void>;
}

/** Fast, DB-free implementation used ONLY by unit tests of the pure
 * algorithm (see `setConfiguredCreativeProfileStoreForTests`) — never
 * the resolved default; see module doc comment's "Persistence" section
 * for the real, production-backed implementation. */
export class InMemoryCreativeProfileStore implements CreativeProfileStore {
  private readonly profiles = new Map<string, CreativeProfile>();

  async getProfile(userId: string): Promise<CreativeProfile> {
    return this.profiles.get(userId) ?? emptyProfile(userId);
  }

  async recordObservation(
    userId: string,
    field: LearnableField,
    value: string,
    signal: "positive" | "negative",
    source: SignalSource,
  ): Promise<void> {
    const profile = this.profiles.get(userId) ?? emptyProfile(userId);
    const existing = profile.fields[field][value];
    const weight = SIGNAL_WEIGHT[source];
    const next: FieldValueScore = {
      positiveWeight: (existing?.positiveWeight ?? 0) + (signal === "positive" ? weight : 0),
      negativeWeight: (existing?.negativeWeight ?? 0) + (signal === "negative" ? weight : 0),
      sampleCount: (existing?.sampleCount ?? 0) + 1,
      lastObservedAt: new Date().toISOString(),
    };
    profile.fields[field][value] = next;
    this.profiles.set(userId, profile);
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
  async getProfile(userId: string): Promise<CreativeProfile> {
    const rows = await listPreferenceObservations(userId);
    const profile = emptyProfile(userId);
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
  ): Promise<void> {
    const weight = SIGNAL_WEIGHT[source];
    await upsertPreferenceObservation(userId, field, value, signal === "positive" ? weight : 0, signal === "negative" ? weight : 0);
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
const SINGLE_VALUE_FIELDS = ["lighting", "composition", "camera", "colorDirection"] as const satisfies readonly LearnableField[];

/**
 * Fills in whichever of `intent`'s learnable fields are currently
 * `null`/empty with this user's highest-confidence learned value for
 * that field, when one clears the application threshold. NEVER touches
 * a field the current message already specified — see module doc
 * comment's "Explicit always wins".
 */
export async function applyLearnedDefaults(userId: string, intent: ParsedIntent): Promise<ParsedIntent> {
  const profile = await getConfiguredCreativeProfileStore().getProfile(userId);
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
}

async function recordFields(
  userId: string,
  fields: LearnableCreativeFields,
  signal: "positive" | "negative",
  source: SignalSource,
): Promise<void> {
  const storeRef = getConfiguredCreativeProfileStore();
  const tasks: Promise<void>[] = [];
  for (const field of SINGLE_VALUE_FIELDS) {
    const value = fields[field];
    if (value) tasks.push(storeRef.recordObservation(userId, field, value, signal, source));
  }
  for (const value of fields.style) {
    tasks.push(storeRef.recordObservation(userId, "style", value, signal, source));
  }
  await Promise.all(tasks);
}

/** The strongest signal — an explicit "I like this" / "not my style"
 * reaction to a specific result (see app/routes/studio.c.$sessionId.tsx's
 * feedback buttons). Records every learnable field value present on the
 * job that produced the result. */
export async function recordExplicitFeedback(
  userId: string,
  fields: LearnableCreativeFields,
  signal: "positive" | "negative",
): Promise<void> {
  await recordFields(userId, fields, signal, "explicit");
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
): Promise<void> {
  await recordFields(userId, fields, decision === "APPROVED" ? "positive" : "negative", "review");
}

/**
 * The weakest, most inferential signal — a same-session follow-up
 * changed a field's value from what was active before. Records a
 * negative observation for the OLD value and a positive one for the
 * NEW value, for every field that both turns specify and that actually
 * differ (a field going from "specified" to "unspecified" is NOT a
 * correction — the merchant simply didn't mention it this turn, which
 * `activeX` carry-forward already handles correctly on its own).
 */
export async function recordCorrectionSignal(
  userId: string,
  previous: LearnableCreativeFields,
  current: LearnableCreativeFields,
): Promise<void> {
  const storeRef = getConfiguredCreativeProfileStore();
  const tasks: Promise<void>[] = [];
  for (const field of SINGLE_VALUE_FIELDS) {
    const prevValue = previous[field];
    const newValue = current[field];
    if (prevValue && newValue && prevValue !== newValue) {
      tasks.push(storeRef.recordObservation(userId, field, prevValue, "negative", "correction"));
      tasks.push(storeRef.recordObservation(userId, field, newValue, "positive", "correction"));
    }
  }
  // `style` is multi-valued — treat a keyword dropped between turns as a
  // mild negative, and a newly-added one as a mild positive, rather than
  // an all-or-nothing "the whole array changed" comparison.
  const prevStyle = new Set(previous.style);
  const newStyle = new Set(current.style);
  if (prevStyle.size > 0 && newStyle.size > 0) {
    for (const value of prevStyle) {
      if (!newStyle.has(value)) tasks.push(storeRef.recordObservation(userId, "style", value, "negative", "correction"));
    }
    for (const value of newStyle) {
      if (!prevStyle.has(value)) tasks.push(storeRef.recordObservation(userId, "style", value, "positive", "correction"));
    }
  }
  await Promise.all(tasks);
}
