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

/**
 * Forces IPv4-only DNS resolution for both connections — the actual fix
 * for the production `connect` -> `close` (ECONNRESET, ~7-10ms later,
 * `everReachedReady: false`) loop.
 *
 * ioredis 6.x's own default is `family: 0` — dual-stack ("Happy
 * Eyeballs"-style) resolution that will race an IPv6 candidate against
 * an IPv4 one for any hostname that publishes both an A and an AAAA
 * record. Our observed timing rules out a remote handshake rejection
 * (auth/protocol failures take at least one real network round-trip to
 * the Redis endpoint, and the closes were happening in single-digit
 * milliseconds — too fast for that) and instead matches a LOCAL/
 * near-network-edge rejection: an IPv6 path that Railway's egress
 * doesn't cleanly support getting an immediate reset before any
 * TLS/Redis-level byte is ever exchanged. This is a documented,
 * recurring class of issue for ioredis running inside Railway
 * specifically (see Railway's own IPv6/dual-stack networking docs and
 * multiple reported ioredis+Railway ECONNRESET/ENOTFOUND issues).
 *
 * REDIS_URL here is the PUBLIC (external) connection string — reachable
 * from both Vercel and the Railway worker — which always resolves over
 * plain IPv4 on the public internet, so forcing `family: 4` costs
 * nothing and removes the broken path entirely rather than trying to
 * make the broken path work.
 */
const IPV4_ONLY: Pick<RedisOptions, "family"> = { family: 4 };

/** Never includes the URL's user/password — only what's safe to log. */
function safeConnectionShape(rawUrl: string): {
  scheme: string | null;
  host: string | null;
  port: string | null;
  tls: boolean;
  usernamePresent: boolean;
  passwordPresent: boolean;
} {
  try {
    const parsed = new URL(rawUrl);
    const scheme = parsed.protocol.replace(/:$/, "");
    return {
      scheme,
      host: parsed.hostname || null,
      port: parsed.port || null,
      tls: scheme === "rediss",
      usernamePresent: parsed.username.length > 0,
      passwordPresent: parsed.password.length > 0,
    };
  } catch {
    return { scheme: null, host: null, port: null, tls: false, usernamePresent: false, passwordPresent: false };
  }
}

/**
 * Classifies a Redis/ioredis error message against Redis's own
 * protocol-standard error-reply vocabulary (WRONGPASS, NOAUTH, ...) —
 * these prefixes are part of the Redis wire protocol itself, not
 * provider-specific or secret, so matching against them is safe. Purely
 * to make a production log line self-diagnosing (distinguish "handshake
 * rejected the credentials/protocol" from "the network dropped the
 * socket") without requiring a human to re-derive it from the raw
 * message every time. Returns `null` when nothing recognizable matches
 * — never asserts a cause it can't support from the message text alone.
 */
function classifyRedisError(message: string): string | null {
  const m = message.toUpperCase();
  if (m.includes("WRONGPASS") || m.includes("INVALID PASSWORD") || m.includes("INVALID USERNAME-PASSWORD")) {
    return "authentication_rejected";
  }
  if (m.includes("NOAUTH")) {
    return "authentication_required";
  }
  if (m.includes("NOPERM")) {
    return "authorization_denied";
  }
  if (m.includes("NOPROTO") || m.includes("UNSUPPORTED PROTOCOL") || m.includes("WRONG NUMBER OF ARGUMENTS FOR 'AUTH'")) {
    return "protocol_negotiation_failed";
  }
  if (m.includes("CERT") || m.includes("SSL") || m.includes("TLS") || m.includes("SELF SIGNED") || m.includes("SELF-SIGNED")) {
    return "tls_handshake_failed";
  }
  if (m.includes("ECONNREFUSED")) {
    return "connection_refused";
  }
  if (m.includes("ENOTFOUND") || m.includes("EAI_AGAIN")) {
    return "dns_resolution_failed";
  }
  if (m.includes("ETIMEDOUT") || m.includes("TIMED OUT")) {
    return "connection_timed_out";
  }
  if (m.includes("ECONNRESET")) {
    return "connection_reset_by_peer";
  }
  return null;
}

function attachDiagnostics(client: Redis, kind: "worker" | "producer"): void {
  const shape = safeConnectionShape(getEnv().REDIS_URL);
  logger.info("redis.connection.configured", { kind, ...shape });

  // Tracked across this client's lifetime so a `close` log line can
  // answer, on its own, the two questions that matter most when
  // diagnosing a connect->close loop: how long did the connection last,
  // and did it EVER reach `ready` even once since process start.
  let connectedAt: number | null = null;
  let everReachedReady = false;

  client.on("connect", () => {
    connectedAt = Date.now();
    logger.info("redis.connection.event", { kind, event: "connect" });
  });
  client.on("ready", () => {
    everReachedReady = true;
    logger.info("redis.connection.event", { kind, event: "ready" });
  });
  client.on("close", () => {
    const msSinceConnect = connectedAt !== null ? Date.now() - connectedAt : null;
    logger.warn("redis.connection.event", { kind, event: "close", msSinceConnect, everReachedReady });
    connectedAt = null;
  });
  client.on("reconnecting", (delayMs: number) => logger.warn("redis.connection.event", { kind, event: "reconnecting", delayMs }));
  client.on("end", () => logger.warn("redis.connection.event", { kind, event: "end", everReachedReady }));
  client.on("error", (error: NodeJS.ErrnoException) => {
    logger.error("redis.connection.event", {
      kind,
      event: "error",
      errorName: error.name,
      errorCode: error.code,
      errorMessage: error.message,
      syscall: error.syscall,
      likelyCause: classifyRedisError(error.message ?? ""),
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
      ...IPV4_ONLY,
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
      ...IPV4_ONLY,
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
