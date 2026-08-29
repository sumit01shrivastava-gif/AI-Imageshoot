import { describe, expect, it } from "vitest";
import { isStudioLatencyEvent, studioLatencyEventKey } from "../../../app/components/studio-ttfvi";

describe("Studio latency telemetry", () => {
  it("uses one safe, result-scoped key per timing event", () => {
    expect(studioLatencyEventKey("RESULT_DETECTED", "job-a", "result-a"))
      .toBe("ai-imageshoot:studio-latency:RESULT_DETECTED:job-a:result-a");
    expect(studioLatencyEventKey("IMAGE_LOAD_START", "job-b", "result-a"))
      .not.toBe(studioLatencyEventKey("IMAGE_LOAD_START", "job-a", "result-a"));
  });

  it("accepts only the explicitly supported, non-sensitive event names", () => {
    expect(isStudioLatencyEvent("RESULT_DETECTED")).toBe(true);
    expect(isStudioLatencyEvent("IMAGE_RENDERED")).toBe(true);
    expect(isStudioLatencyEvent("prompt")).toBe(false);
    expect(isStudioLatencyEvent("IMAGE_URL")).toBe(false);
  });
});
