import { describe, expect, it } from "vitest";
import { IDLE_WORKER_DRAIN_DELAY_SECONDS } from "../../../lib/queue/queue.server";

describe("worker idle queue behavior", () => {
  it("uses a one-minute blocking drain delay for an empty queue", () => {
    // BullMQ 6.1.2 permits any positive drainDelay. This is an idle-cost
    // optimization only: a newly enqueued job still wakes BZPOPMIN immediately.
    expect(IDLE_WORKER_DRAIN_DELAY_SECONDS).toBe(60);
  });
});
