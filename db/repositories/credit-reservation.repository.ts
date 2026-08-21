/**
 * Repository for `CreditReservation` — the reserve/settle/refund credit
 * -hold ledger backing services/usage/entitlement.server.ts. See
 * prisma/schema.prisma's model comment for why this is a separate table
 * from `UsageEvent`.
 *
 * Every function here is shop-scoped by its own `where` clause (never a
 * separate ownership check) — mirrors db/repositories/usage-event.repository.ts's
 * identical reasoning.
 */
import type { CreditReservationStatus, UsageOperationType } from "@prisma/client";
import prisma from "../client.server";

export interface CreditReservationRow {
  id: string;
  jobId: string;
  operationType: UsageOperationType;
  amount: number;
  status: CreditReservationStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

const RESERVATION_SELECT = {
  id: true,
  jobId: true,
  operationType: true,
  amount: true,
  status: true,
  createdAt: true,
  resolvedAt: true,
} as const;

/**
 * Creates a RESERVED hold for `jobId`, or returns the existing one if a
 * reservation for this job already exists — `@unique` on `jobId` makes
 * this naturally idempotent (Prisma's `upsert` with an empty `update`):
 * a retried/duplicate reservation attempt for the same job is a safe
 * no-op, never a double hold. See docs/usage.md "Credit lifecycle".
 */
export async function createReservation(
  shop: string,
  jobId: string,
  operationType: UsageOperationType,
  amount: number,
): Promise<CreditReservationRow> {
  return prisma.creditReservation.upsert({
    where: { jobId },
    create: { shop, jobId, operationType, amount, status: "RESERVED" },
    update: {},
    select: RESERVATION_SELECT,
  });
}

/** Moves a RESERVED hold to CONSUMED (the operation succeeded — the
 * credit is genuinely spent). A conditional update (`status: "RESERVED"`
 * in the `where`) rather than read-then-write: calling this twice, or
 * calling it when no reservation exists at all (e.g. a job that was
 * never credit-aware), both safely affect zero rows — idempotent by
 * construction, no separate existence check needed. */
export async function settleReservation(shop: string, jobId: string): Promise<void> {
  await prisma.creditReservation.updateMany({
    where: { shop, jobId, status: "RESERVED" },
    data: { status: "CONSUMED", resolvedAt: new Date() },
  });
}

/** Moves a RESERVED hold to REFUNDED (the operation failed — the credit
 * must never be permanently consumed for a failed request; see
 * docs/usage.md "Failure/refund behavior"). Same idempotent conditional
 * -update shape as `settleReservation`. */
export async function refundReservation(shop: string, jobId: string): Promise<void> {
  await prisma.creditReservation.updateMany({
    where: { shop, jobId, status: "RESERVED" },
    data: { status: "REFUNDED", resolvedAt: new Date() },
  });
}

export async function getReservationForJob(shop: string, jobId: string): Promise<CreditReservationRow | null> {
  return prisma.creditReservation.findFirst({ where: { shop, jobId }, select: RESERVATION_SELECT });
}

/** Sum of every credit currently counted against this shop's monthly
 * allowance since `monthStart` — both genuinely CONSUMED holds
 * (completed operations) AND still-outstanding RESERVED holds (a
 * request currently in flight also counts against the limit
 * immediately, so two concurrent requests can't both squeeze through a
 * nearly-exhausted allowance). REFUNDED holds never count — a failed
 * operation's credit was given back. Optionally scoped to one
 * `operationType` (e.g. "how many IMAGE_GENERATION credits has this shop
 * used this month" for a per-operation breakdown) — omitted sums across
 * every operation type, the shop's overall usage against its plan
 * allowance. See services/usage/entitlement.server.ts's
 * `checkGenerationEntitlement`. */
export async function getMonthlyCreditsUsed(shop: string, monthStart: Date, operationType?: UsageOperationType): Promise<number> {
  const result = await prisma.creditReservation.aggregate({
    where: {
      shop,
      createdAt: { gte: monthStart },
      status: { in: ["CONSUMED", "RESERVED"] },
      ...(operationType ? { operationType } : {}),
    },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

export type { CreditReservationStatus, UsageOperationType };
