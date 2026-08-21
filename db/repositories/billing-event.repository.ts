/**
 * Repository for `BillingEvent` — the idempotent audit trail for every
 * billing action (merchant-initiated and webhook-delivered). See the
 * model's schema comment: `idempotencyKey` is what makes a redelivered
 * webhook, or a merchant double-clicking "Upgrade", a safe no-op.
 */
import { Prisma } from "@prisma/client";
import type { BillingEventType, PlanId } from "@prisma/client";
import prisma from "../client.server";

export interface BillingEventRow {
  id: string;
  shop: string;
  type: BillingEventType;
  shopifySubscriptionId: string | null;
  fromPlanId: PlanId | null;
  toPlanId: PlanId | null;
  idempotencyKey: string;
  metadata: unknown;
  createdAt: Date;
}

export interface CreateBillingEventInput {
  shop: string;
  type: BillingEventType;
  shopifySubscriptionId?: string | null;
  fromPlanId?: PlanId | null;
  toPlanId?: PlanId | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records a billing event — or, if `idempotencyKey` was already used
 * (a duplicate webhook delivery, or a double-submitted upgrade action),
 * returns the ALREADY-RECORDED row untouched instead of throwing or
 * creating a duplicate. Callers should branch on whether the returned
 * row's `id` was newly created by checking `wasNew` rather than
 * inferring it from field equality.
 */
export async function recordBillingEvent(input: CreateBillingEventInput): Promise<{ event: BillingEventRow; wasNew: boolean }> {
  const existing = await prisma.billingEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { event: existing, wasNew: false };

  try {
    const created = await prisma.billingEvent.create({
      data: {
        shop: input.shop,
        type: input.type,
        shopifySubscriptionId: input.shopifySubscriptionId ?? null,
        fromPlanId: input.fromPlanId ?? null,
        toPlanId: input.toPlanId ?? null,
        idempotencyKey: input.idempotencyKey,
        metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      },
    });
    return { event: created, wasNew: true };
  } catch {
    // A concurrent request won the race on the same idempotencyKey
    // between our findUnique and create — fetch what it wrote rather
    // than surfacing the unique-constraint error.
    const raced = await prisma.billingEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (raced) return { event: raced, wasNew: false };
    throw new Error("Failed to record billing event and could not recover the concurrent write.");
  }
}

export async function listBillingEvents(shop: string, limit = 50): Promise<BillingEventRow[]> {
  return prisma.billingEvent.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: limit });
}
