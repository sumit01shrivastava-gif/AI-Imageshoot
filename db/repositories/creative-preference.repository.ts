/**
 * Repository for `CreativePreferenceObservation` — see
 * prisma/schema.prisma's own doc comment for the full data-model
 * reasoning. The persistent backing for
 * services/creative-studio/personalization.server.ts's
 * `CreativeProfileStore`.
 *
 * Scoped by `userId`, not `shop` — see personalization.server.ts's
 * module doc comment. No `AuthContext`/`assertShopOwnership` check here
 * (unlike every other repository in this codebase): there is no `shop`
 * on this table at all, by design — a learned creative preference
 * belongs to the authenticated standalone User, independent of which
 * workspace they're acting in. Callers (personalization.server.ts) only
 * ever pass a `userId` already resolved server-side by
 * `requireWorkspaceContext` (lib/auth/standalone-session.server.ts) —
 * never a client-supplied value trusted directly, satisfying the same
 * "never trust an id from the browser" principle every other repository
 * enforces via `assertShopOwnership`, just via a different mechanism
 * (the id itself is never accepted as input in the first place).
 *
 * Every read/write is additionally scoped by `context` (see
 * prisma/schema.prisma's `CreativePreferenceObservation.context` doc
 * comment) — a coarse creative-request bucket
 * ("campaign"/"catalog"/"general") derived from the request's `intent`
 * by personalization.server.ts's `contextForIntent`. There is
 * deliberately no cross-context query anywhere in this file: a caller
 * always names the one context it cares about.
 */
import prisma from "../client.server";

export interface PreferenceObservationRow {
  field: string;
  value: string;
  positiveWeight: number;
  negativeWeight: number;
  sampleCount: number;
  lastObservedAt: Date;
}

/** Every observation recorded for this user IN THIS CONTEXT — the raw
 * material `personalization.server.ts`'s `PrismaCreativeProfileStore`
 * assembles into a `CreativeProfile`. Never returns another context's
 * rows — see module doc comment. */
export async function listPreferenceObservations(userId: string, context: string): Promise<PreferenceObservationRow[]> {
  return prisma.creativePreferenceObservation.findMany({
    where: { userId, context },
    select: { field: true, value: true, positiveWeight: true, negativeWeight: true, sampleCount: true, lastObservedAt: true },
  });
}

/** Records one observation — an upsert keyed by the (userId, field,
 * value, context) quadruple (prisma/schema.prisma's `@@unique`), so a
 * repeated observation of an already-seen (value, context) pair
 * accumulates onto the same row rather than creating a new one.
 * `positiveDelta`/`negativeDelta` are the SIGNAL_WEIGHT-scaled amounts
 * to add this call — exactly one of the two is non-zero per call (see
 * personalization.server.ts's `recordObservation`). */
export async function upsertPreferenceObservation(
  userId: string,
  field: string,
  value: string,
  positiveDelta: number,
  negativeDelta: number,
  context: string,
): Promise<void> {
  await prisma.creativePreferenceObservation.upsert({
    where: { userId_field_value_context: { userId, field, value, context } },
    create: {
      userId,
      field,
      value,
      context,
      positiveWeight: positiveDelta,
      negativeWeight: negativeDelta,
      sampleCount: 1,
      lastObservedAt: new Date(),
    },
    update: {
      positiveWeight: { increment: positiveDelta },
      negativeWeight: { increment: negativeDelta },
      sampleCount: { increment: 1 },
      lastObservedAt: new Date(),
    },
  });
}

/** Test-only: deletes every observation for a user — mirrors this
 * codebase's other test-cleanup helpers (never called from application
 * code; a real user-initiated deletion goes through `onDelete: Cascade`
 * when the `User` row itself is deleted, e.g. a future account-deletion
 * flow, not through this function). */
export async function deletePreferenceObservationsForTests(userId: string): Promise<void> {
  await prisma.creativePreferenceObservation.deleteMany({ where: { userId } });
}
