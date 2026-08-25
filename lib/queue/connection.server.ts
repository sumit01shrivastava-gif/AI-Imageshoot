/**
 * Redis connections for BullMQ — TWO separate connections, not one, as of
 * this pass. See docs/production-deployment.md and the production
 * investigation this fixes.
 *
 * Why two: this module is imported from two genuinely different runtime
 * contexts that need different connection behavior:
 *
 *   - `getWorkerRedisConnection()` — used by `createWorker` (lib/queue/queue.server.ts),
 *     which is ONLY ever called from workers/index.ts, a long-lived
 *     process (Railway). BullMQ's Worker/QueueEvents use blocking Redis
 *     commands (BRPOPLPUSH-style) that require `maxRetriesPerRequest: null`
 *     (see https://docs.bullmq.io/guide/going-to-production) — with a
 *     process that lives for hours/days, "keep retrying forever rather
 *     than ever give up" is exactly the right behavior for its own
 *     connection.
 *   - `getProducerRedisConnection()` — used by `createQueue`, which is
 *     called from ordinary request handlers (Vercel serverless functions
 *     — every domain's "request-generation.server.ts"-style enqueue
 *     call, both the Shopify-embedded app's and the standalone studio's).
 *     A request
 *     handler has a bounded lifetime and an end user waiting on the
 *     response; `maxRetriesPerRequest: null` here means a genuinely
 *     broken/unreachable Redis makes `queue.add()` retry indefinitely
 *     instead of failing — the exact bug this pass fixes (production
 *     symptom: `.add()` hanging for 13+ seconds before finally rejecting
 *     with ioredis's generic "Connection is closed.", instead of failing
 *     fast with a clear, catchable error). A bounded `maxRetriesPerRequest`
 *     plus an explicit `connectTimeout` makes a broken connection fail
 *     quickly and clearly instead.
 *
 * Both still use `lazyConnect: true` — constructing this module (e.g. at
 * import time in a route that never touches a queue) never opens a
 * socket or throws just because Redis isn't reachable yet.
 *
 * Non-secret connection diagnostics (scheme/host/port — NEVER the
 * user/password portion of the URL) are logged on every connection-state
 * transition (connect/ready/close/reconnecting/error) via the redacting
 * `logger`, which additionally scans every logged value for any
 * currently-configured secret's literal content regardless — see
 * lib/logging/logger.server.ts's module doc comment. This is what makes
 * a future connection problem (TLS mismatch, wrong host, auth failure,
 * ...) diagnosable from server-side logs alone, without ever needing to
 * read back the real REDIS_URL.
 */
import IORedis, { type Redis, type RedisOptions } from "ioredis";
import { getEnv } from "../validation/env.server";
import { logger } from "../logging/logger.server";

let workerConnection: Redis | undefined;
let producerConnection: Redis | undefined;

/** Never includes the URL's user/password — only what's safe to log. */
function safeConnectionShape(rawUrl: string): { scheme: string | null; host: string | null; port: string | null; tls: boolean } {
  try {
    const parsed = new URL(rawUrl);
    const scheme = parsed.protocol.replace(/:$/, "");
    return {
      scheme,
      host: parsed.hostname || null,
      port: parsed.port || null,
      tls: scheme === "rediss",
    };
  } catch {
    return { scheme: null, host: null, port: null, tls: false };
  }
}

function attachDiagnostics(client: Redis, kind: "worker" | "producer"): void {
  const shape = safeConnectionShape(getEnv().REDIS_URL);
  logger.info("redis.connection.configured", { kind, ...shape });

  client.on("connect", () => logger.info("redis.connection.event", { kind, event: "connect" }));
  client.on("ready", () => logger.info("redis.connection.event", { kind, event: "ready" }));
  client.on("close", () => logger.warn("redis.connection.event", { kind, event: "close" }));
  client.on("reconnecting", (delayMs: number) => logger.warn("redis.connection.event", { kind, event: "reconnecting", delayMs }));
  client.on("end", () => logger.warn("redis.connection.event", { kind, event: "end" }));
  client.on("error", (error: NodeJS.ErrnoException) => {
    logger.error("redis.connection.event", {
      kind,
      event: "error",
      errorName: error.name,
      errorCode: error.code,
      errorMessage: error.message,
      syscall: error.syscall,
    });
  });
}

/** The WORKER connection — see module doc comment. Unchanged from before
 * this pass; only ever used by `createWorker` (workers/index.ts,
 * Railway). */
export function getWorkerRedisConnection(): Redis {
  if (!workerConnection) {
    workerConnection = new IORedis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    attachDiagnostics(workerConnection, "worker");
  }
  return workerConnection;
}

/** @deprecated Use `getWorkerRedisConnection` — kept as an alias so
 * existing worker/test call sites (which predate the producer/worker
 * split) keep working unchanged. Never use this for a `createQueue`
 * producer call site; see module doc comment. */
export function getRedisConnection(): Redis {
  return getWorkerRedisConnection();
}

/** The PRODUCER connection — see module doc comment for why this needs
 * different options than the worker connection above. New this pass. */
export function getProducerRedisConnection(): Redis {
  if (!producerConnection) {
    const options: RedisOptions = {
      // Bounded, unlike the worker connection — a request handler must
      // fail fast and clearly, never retry indefinitely. This is the
      // actual fix for the production symptom (see module doc comment).
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      lazyConnect: true,
    };
    producerConnection = new IORedis(getEnv().REDIS_URL, options);
    attachDiagnostics(producerConnection, "producer");
  }
  return producerConnection;
}

/** Test/shutdown helper: closes and clears both shared connections. */
export async function closeRedisConnection(): Promise<void> {
  if (workerConnection) {
    await workerConnection.quit().catch(() => workerConnection?.disconnect());
    workerConnection = undefined;
  }
  if (producerConnection) {
    await producerConnection.quit().catch(() => producerConnection?.disconnect());
    producerConnection = undefined;
  }
}
