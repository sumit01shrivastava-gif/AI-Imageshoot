/**
 * BullMQ job payload + processor for the `"catalog-sync"` queue.
 *
 * Producers (the manual "Sync now" action and the product webhook
 * handlers) enqueue onto this queue via `lib/queue`; `workers/index.ts`
 * registers `processCatalogSyncJob` against it. Job logic itself lives
 * here, in the owning `services/products` module, not inline in the
 * worker file — see CLAUDE.md "Queue rules".
 *
 * Every job type is idempotent (safe-upsert / safe-delete), matching
 * BullMQ's at-least-once delivery semantics.
 */
import type { Processor } from "bullmq";
import { unauthenticated } from "../shopify";
import { runCatalogSync, syncSingleProduct, removeSyncedProduct } from "./sync.server";
import { logger } from "../../lib/logging/logger.server";
import type { SyncMode } from "./types";

export type CatalogSyncJobPayload =
  | { type: "full-sync"; shop: string; mode: SyncMode }
  | { type: "product-upsert"; shop: string; shopifyProductId: string }
  | { type: "product-delete"; shop: string; shopifyProductId: string };

/** Deterministic job id so rapid repeat webhook deliveries for the same
 * product collapse into one queued job instead of piling up — see
 * CLAUDE.md "Queue rules" (idempotent where at-least-once delivery makes
 * that possible) and the webhook handlers, which pass this as `jobId`. */
export function catalogSyncJobId(payload: CatalogSyncJobPayload): string {
  switch (payload.type) {
    case "full-sync":
      return `full-sync:${payload.shop}`;
    case "product-upsert":
      return `product-upsert:${payload.shop}:${payload.shopifyProductId}`;
    case "product-delete":
      return `product-delete:${payload.shop}:${payload.shopifyProductId}`;
  }
}

export const processCatalogSyncJob: Processor<CatalogSyncJobPayload> = async (job) => {
  const payload = job.data;
  logger.info("products.sync_job.start", { type: payload.type, shop: payload.shop });

  switch (payload.type) {
    case "full-sync": {
      const { admin } = await unauthenticated.admin(payload.shop);
      await runCatalogSync(admin, payload.shop, payload.mode);
      return;
    }
    case "product-upsert": {
      const { admin } = await unauthenticated.admin(payload.shop);
      await syncSingleProduct(admin, payload.shop, payload.shopifyProductId);
      return;
    }
    case "product-delete": {
      await removeSyncedProduct(payload.shop, payload.shopifyProductId);
      return;
    }
  }
};
