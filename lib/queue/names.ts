/**
 * Known queue names.
 *
 * Declared now so the rest of the codebase has one canonical set of names to
 * reference. Each gets real producers/processors when the phase that needs
 * it lands:
 *
 *   - "catalog-sync" → Shopify product/media catalog sync (Phase 1) — see
 *     services/products/sync.server.ts and workers/index.ts
 *   - "generation"   → AI image generation jobs (future)
 *   - "enhancement"  → background removal / cleanup / upscale jobs (future)
 *   - "publishing"   → publishing approved assets back to Shopify (future)
 */
export const QUEUE_NAMES = ["catalog-sync", "generation", "enhancement", "publishing"] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
