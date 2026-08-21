/**
 * Known queue names.
 *
 * Declared now so the rest of the codebase has one canonical set of names to
 * reference. Each gets real producers/processors when the phase that needs
 * it lands:
 *
 *   - "catalog-sync"          → Shopify product/media catalog sync
 *     (Phase 1) — see services/products/sync.server.ts and workers/index.ts
 *   - "product-intelligence"  → Product Intelligence analysis (Phase 2) —
 *     see services/intelligence/job.server.ts and workers/index.ts
 *   - "generation"            → AI image generation jobs (Phase 3) — see
 *     services/generation/job.server.ts and workers/index.ts
 *   - "enhancement"           → background removal / cleanup / upscale jobs — see
 *     services/processing/job.server.ts and workers/index.ts
 *   - "store-visuals"         → store-level visual generation (homepage hero,
 *     collection banner, store CTA — not product-scoped) — see
 *     services/store-visuals/job.server.ts and workers/index.ts
 *   - "publishing"            → publishing approved assets back to Shopify (future)
 */
export const QUEUE_NAMES = [
  "catalog-sync",
  "product-intelligence",
  "generation",
  "enhancement",
  "store-visuals",
  "publishing",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
