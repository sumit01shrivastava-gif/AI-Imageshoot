/**
 * Known queue names.
 *
 * Declared now so the rest of the codebase has one canonical set of names to
 * reference; no job is registered on any of them yet (see workers/README.md).
 * Each will get real producers/processors in a later phase:
 *
 *   - "generation"  → AI image generation jobs
 *   - "enhancement" → background removal / cleanup / upscale jobs
 *   - "publishing"  → publishing approved assets back to Shopify
 */
export const QUEUE_NAMES = ["generation", "enhancement", "publishing"] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
