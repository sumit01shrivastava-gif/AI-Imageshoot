/**
 * Shared Redis connection for BullMQ.
 *
 * `lazyConnect: true` and `maxRetriesPerRequest: null` matter here:
 *   - lazyConnect means constructing this module (e.g. at import time in
 *     tests, or in a route that never touches a queue) never opens a socket
 *     or throws just because Redis isn't reachable yet.
 *   - maxRetriesPerRequest: null is required by BullMQ for its blocking
 *     connections (see https://docs.bullmq.io/guide/going-to-production).
 *
 * One connection is shared by every Queue/Worker created through this
 * module, per BullMQ's recommended production setup.
 */
import IORedis, { type Redis } from "ioredis";
import { getEnv } from "../validation/env.server";

let connection: Redis | undefined;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new IORedis(getEnv().REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }
  return connection;
}

/** Test/shutdown helper: closes and clears the shared connection. */
export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit().catch(() => connection?.disconnect());
    connection = undefined;
  }
}
