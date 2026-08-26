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

/** Every observation ever recorded for this user — the raw material
 * `personalization.server.ts`'s `PrismaCreativeProfileStore` assembles
 * into a `CreativeProfile`. */
export async function listPreferenceObservations(userId: string): Promise<PreferenceObservationRow[]> {
  return prisma.creativePreferenceObservation.findMany({
    where: { userId },
    select: { field: true, value: true, positiveWeight: true, negativeWeight: true, sampleCount: true, lastObservedAt: true },
  });
}

/** Records one observation — an upsert keyed by the (userId, field,
 * value) triple (prisma/schema.prisma's `@@unique`), so a repeated
 * observation of an already-seen value accumulates onto the same row
 * rather than creating a new one. `positiveDelta`/`negativeDelta` are
 * the SIGNAL_WEIGHT-scaled amounts to add this call — exactly one of
 * the two is non-zero per call (see personalization.server.ts's
 * `recordObservation`). */
export async function upsertPreferenceObservation(
  userId: string,
  field: string,
  value: string,
  positiveDelta: number,
  negativeDelta: number,
): Promise<void> {
  await prisma.creativePreferenceObservation.upsert({
    where: { userId_field_value: { userId, field, value } },
    create: {
      userId,
      field,
      value,
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
