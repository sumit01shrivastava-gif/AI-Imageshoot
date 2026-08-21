/**
 * Repository for `ShopSubscription` — one row per shop holding its
 * current plan/subscription state. Absence of a row means FREE (see the
 * model's schema comment); every read function here returns `null` for
 * "no row" rather than materializing a default row, and callers
 * (services/billing/subscription.server.ts) apply the FREE fallback.
 *
 * Shop-scoped by its own `where` clause throughout — mirrors every other
 * repository in this codebase.
 */
import type { PlanId, SubscriptionStatus } from "@prisma/client";
import prisma from "../client.server";

export interface ShopSubscriptionRow {
  id: string;
  shop: string;
  planId: PlanId;
  status: SubscriptionStatus;
  shopifySubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getShopSubscription(shop: string): Promise<ShopSubscriptionRow | null> {
  return prisma.shopSubscription.findUnique({ where: { shop } });
}

export async function findShopSubscriptionByShopifyId(shopifySubscriptionId: string): Promise<ShopSubscriptionRow | null> {
  return prisma.shopSubscription.findFirst({ where: { shopifySubscriptionId } });
}

/** Creates or fully replaces a shop's subscription state — used on
 * initial `appSubscriptionCreate` request (PENDING, no period yet) and
 * on webhook-driven status sync (ACTIVE with a real period). Upsert
 * keyed on the unique `shop` column, so this is safe to call repeatedly
 * for the same shop without a separate existence check. */
export async function upsertShopSubscription(
  shop: string,
  data: {
    planId: PlanId;
    status: SubscriptionStatus;
    shopifySubscriptionId?: string | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
  },
): Promise<ShopSubscriptionRow> {
  return prisma.shopSubscription.upsert({
    where: { shop },
    create: { shop, ...data },
    update: { ...data },
  });
}
