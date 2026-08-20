/**
 * Repository for `ShopSyncState` — one row per shop, tracking catalog sync
 * bookkeeping (see prisma/schema.prisma and docs/database.md). Every
 * function is already shop-scoped by its `shop` parameter (the model's
 * primary key), so there's no separate ownership check to perform here —
 * the caller is expected to pass `context.shop`, never a client-supplied
 * value (see services/products/sync.server.ts).
 */
import type { SyncStatus } from "@prisma/client";
import prisma from "../client.server";

export interface ShopSyncStateRow {
  shop: string;
  status: SyncStatus;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

export async function getSyncState(shop: string): Promise<ShopSyncStateRow | null> {
  return prisma.shopSyncState.findUnique({
    where: { shop },
    select: { shop: true, status: true, lastSyncedAt: true, lastError: true },
  });
}

export async function markSyncStarted(shop: string): Promise<void> {
  await prisma.shopSyncState.upsert({
    where: { shop },
    create: { shop, status: "SYNCING" },
    update: { status: "SYNCING", lastError: null },
  });
}

/**
 * `syncedAt` must be the timestamp the sync *started* at, not when it
 * finished — see services/products/sync.server.ts's `runCatalogSync` for
 * why (using completion time as the next incremental sync's watermark
 * opens a race window that can permanently skip products edited while a
 * sync was running). This function only persists whatever timestamp the
 * caller hands it; it doesn't decide that policy.
 */
export async function markSyncSucceeded(shop: string, syncedAt: Date): Promise<void> {
  await prisma.shopSyncState.upsert({
    where: { shop },
    create: { shop, status: "IDLE", lastSyncedAt: syncedAt },
    update: { status: "IDLE", lastSyncedAt: syncedAt, lastError: null },
  });
}

/** `message` must already be merchant-safe (no stack traces/internal
 * detail) — see CLAUDE.md "Safe error handling". */
export async function markSyncFailed(shop: string, message: string): Promise<void> {
  await prisma.shopSyncState.upsert({
    where: { shop },
    create: { shop, status: "FAILED", lastError: message },
    update: { status: "FAILED", lastError: message },
  });
}
