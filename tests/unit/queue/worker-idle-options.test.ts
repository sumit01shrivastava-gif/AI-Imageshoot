import { describe, expect, it } from "vitest";
import { IDLE_WORKER_DRAIN_DELAY_SECONDS } from "../../../lib/queue/queue.server";

describe("worker idle queue behavior", () => {
  it("uses BullMQ's supported maximum blocking drain delay", () => {
    // BullMQ 6.1.2 caps an empty worker's BZPOPMIN wait at ten seconds.
    // This is an idle-cost optimization only: a newly enqueued job still
    // wakes the blocking call immediately.
    expect(IDLE_WORKER_DRAIN_DELAY_SECONDS).toBe(10);
  });
});
