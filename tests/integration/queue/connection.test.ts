/**
 * Integration tests for the producer/worker Redis connection split
 * (lib/queue/connection.server.ts) — the fix for the production
 * "Couldn't queue this request" failure (standalone Creative Studio,
 * Vercel → Redis → Railway path).
 *
 * Root cause this guards against: a single shared Redis connection was
 * built with `maxRetriesPerRequest: null` (correct for BullMQ's
 * Worker/QueueEvents, per https://docs.bullmq.io/guide/going-to-production
 * — those use blocking commands and run in a long-lived process) but was
 * ALSO used for the Queue *producer* side, which every serverless
 * request handler (Vercel) goes through. `null` there means a broken/
 * unreachable Redis makes `.add()` retry indefinitely instead of failing
 * fast — observed in production as a ~13s hang before a generic
 * "Connection is closed." rejection. See connection.server.ts's module
 * doc comment for the full writeup.
 *
 * This suite runs against the real local Redis (docker-compose — see
 * tests/setup.ts) through the actual production factories
 * (`createQueue`/`createWorker`, `getProducerRedisConnection`/
 * `getWorkerRedisConnection`) — never a mock — and reuses the real
 * `"generation"` queue name (lib/queue/names.ts) rather than inventing a
 * test-only one, per CLAUDE.md's "don't invent a queue name inline"
 * rule. It never touches the AI provider — this is purely about the
 * enqueue path, not generation itself.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";
import {
  createQueue,
  createWorker,
  closeRedisConnection,
  getProducerRedisConnection,
  getWorkerRedisConnection,
} from "../../../lib/queue";

describe("producer/worker Redis connection split", () => {
  afterEach(async () => {
    await closeRedisConnection();
  });

  it("returns two distinct connection instances, each memoized across calls", () => {
    const producer1 = getProducerRedisConnection();
    const producer2 = getProducerRedisConnection();
    const worker1 = getWorkerRedisConnection();
    const worker2 = getWorkerRedisConnection();

    // Memoized: repeated calls return the same instance, not a new
    // connection every time.
    expect(producer1).toBe(producer2);
    expect(worker1).toBe(worker2);

    // Distinct: producer and worker never share a connection.
    expect(producer1).not.toBe(worker1);
  });

  it("gives the producer connection bounded retry/timeout options — never `maxRetriesPerRequest: null`", () => {
    const producer = getProducerRedisConnection();
    // ioredis exposes the options it was constructed with on `.options`.
    expect(producer.options.maxRetriesPerRequest).toBe(2);
    expect(producer.options.connectTimeout).toBe(5000);
  });

  it("gives the worker connection `maxRetriesPerRequest: null`, as BullMQ's Worker/QueueEvents require", () => {
    const worker = getWorkerRedisConnection();
    expect(worker.options.maxRetriesPerRequest).toBeNull();
  });

  it("createQueue's underlying connection is the producer connection, not the worker one", async () => {
    const queue = createQueue("generation");
    try {
      // This BullMQ version routes the raw ioredis client through its
      // backend abstraction (`getBackend().client`, a promise that
      // resolves once connected) as a cached Proxy adapter, not the raw
      // ioredis instance itself — so we can't assert `.toBe()` against
      // `getProducerRedisConnection()` directly. Its `.options` are
      // forwarded through the proxy unchanged, so asserting on those is
      // the reliable way to confirm which underlying connection (bounded
      // producer vs. `null`-retry worker) BullMQ actually picked up.
      const client = await queue.getBackend().client;
      expect(client.options.maxRetriesPerRequest).toBe(
        getProducerRedisConnection().options.maxRetriesPerRequest,
      );
      expect(client.options.maxRetriesPerRequest).not.toBe(
        getWorkerRedisConnection().options.maxRetriesPerRequest,
      );
    } finally {
      await queue.close();
    }
  });

  it("createWorker's underlying connection is the worker connection, not the producer one", async () => {
    const worker: Worker = createWorker("generation", async () => undefined, {
      autorun: false,
    });
    try {
      await worker.waitUntilReady();
      const client = await worker.getBackend().client;
      expect(client.options.maxRetriesPerRequest).toBe(
        getWorkerRedisConnection().options.maxRetriesPerRequest,
      );
      expect(client.options.maxRetriesPerRequest).not.toBe(
        getProducerRedisConnection().options.maxRetriesPerRequest,
      );
    } finally {
      await worker.close();
    }
  });

  it("performs a real end-to-end BullMQ enqueue through the producer connection against local Redis", async () => {
    const queue = createQueue<{ marker: string }>("generation");
    const jobId = `connection-test-${Date.now()}`;
    let worker: Worker<{ marker: string }> | undefined;
    try {
      const processed = new Promise<{ marker: string }>((resolve, reject) => {
        worker = createWorker<{ marker: string }>(
          "generation",
          async (job) => {
            resolve(job.data);
          },
        );
        worker.on("failed", (_job, error) => reject(error));
      });

      // This is the exact operation the production "Couldn't queue this
      // request" catch block wraps — a real `.add()` through the
      // producer connection. It must resolve quickly, not hang for
      // seconds, against a healthy local Redis.
      const started = Date.now();
      await queue.add("connection-test", { marker: "ok" }, { jobId });
      expect(Date.now() - started).toBeLessThan(2000);

      const data = await processed;
      expect(data).toEqual({ marker: "ok" });
    } finally {
      await worker?.close();
      await queue.close();
    }
  });
});

afterAll(async () => {
  await closeRedisConnection();
});
