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
 *
 * Job-id dedup: see `lib/queue/queue.server.ts`'s module doc comment for
 * the full reasoning. In short — `catalogSyncJobId` below is deliberately
 * stable/deterministic per shop or per shop+product, which collapses
 * duplicate *in-flight* deliveries onto one job; `createQueue`'s
 * `removeOnComplete`/`removeOnFail` defaults are what make that safe by
 * freeing the id again the moment a job finishes, so a completed or
 * failed sync never blocks the next legitimate one. The two must be
 * changed together, not independently.
 */
import type { Processor } from "bullmq";
import { createHash } from "node:crypto";
import { unauthenticated } from "../shopify";
import { runCatalogSync, syncSingleProduct, removeSyncedProduct } from "./sync.server";
import { logger } from "../../lib/logging/logger.server";
import type { SyncMode } from "./types";

export type CatalogSyncJobPayload =
  | { type: "full-sync"; shop: string; mode: SyncMode }
  | { type: "product-upsert"; shop: string; shopifyProductId: string }
  | { type: "product-delete"; shop: string; shopifyProductId: string };

/**
 * Hashes the dedup key's parts into a fixed-charset (hex) suffix, joined by
 * a NUL separator so e.g. `(shop: "a", id: "bc")` and `(shop: "ab", id:
 * "c")` can never hash to the same value.
 *
 * Why hash instead of embedding the raw values: BullMQ rejects a custom
 * jobId containing `:` unless splitting on `:` yields exactly 3 parts (a
 * legacy carve-out for its own repeatable-job id format — see bullmq's
 * `Job.validateOptions`). Shopify's GraphQL ids
 * (`gid://shopify/Product/123`) contain a `:`, so an earlier version of
 * this function that embedded shop/id verbatim (`product-upsert:{shop}:
 * {id}`) threw `"Custom Id cannot contain :"` on essentially every real
 * call — caught by tests/integration/queue/catalog-sync-queue.test.ts.
 * Hashing sidesteps the whole character-set question rather than trying to
 * enumerate/strip whatever BullMQ (or some future Shopify id format)
 * happens to reject.
 */
function hashDedupKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/** Deterministic job id so rapid repeat webhook deliveries for the same
 * product/shop collapse onto one in-flight job instead of piling up — see
 * CLAUDE.md "Queue rules" (idempotent where at-least-once delivery makes
 * that possible), the webhook handlers (which pass this as `jobId`), and
 * this file's top comment for why that's safe to reuse after the job
 * finishes. The `full-sync-`/`product-upsert-`/`product-delete-` prefix is
 * purely for human-readability in Redis/logs; uniqueness comes from the
 * hash. */
export function catalogSyncJobId(payload: CatalogSyncJobPayload): string {
  switch (payload.type) {
    case "full-sync":
      return `full-sync-${hashDedupKey(payload.shop)}`;
    case "product-upsert":
      return `product-upsert-${hashDedupKey(payload.shop, payload.shopifyProductId)}`;
    case "product-delete":
      return `product-delete-${hashDedupKey(payload.shop, payload.shopifyProductId)}`;
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
