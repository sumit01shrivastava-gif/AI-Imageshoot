/**
 * Deterministic, BullMQ-safe job id helper.
 *
 * Shared by every queue that wants "collapse duplicate in-flight work, but
 * let a finished job's id be reused" semantics — see queue.server.ts's
 * module doc comment for the full reasoning, and
 * services/products/sync-job.server.ts's history for the bug this
 * generalizes the fix for (the Phase 0/1 security audit).
 *
 * Hashes the given parts (NUL-joined, so e.g. `("a", "bc")` and
 * `("ab", "c")` can never collide) into a fixed hex charset. BullMQ
 * rejects a custom jobId containing `:` unless it splits into exactly 3
 * `:`-separated parts (see bullmq's `Job.validateOptions`), and some
 * identifiers a job id might otherwise be built from (e.g. Shopify
 * GraphQL ids, which contain `gid://...`) do contain `:`. Hashing
 * sidesteps the character-set question entirely rather than depending on
 * the shape of an id this module doesn't control.
 */
import { createHash } from "node:crypto";

function hashParts(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/**
 * Builds a full, human-readable-prefixed, BullMQ-safe job id from a
 * dedup key's parts. `prefix` is purely for readability in Redis/logs
 * (e.g. `"product-upsert"`); uniqueness comes entirely from the hash.
 */
export function buildJobId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${hashParts(parts)}`;
}
