import { describe, expect, it } from "vitest";
import { getStudioGenerationSubmittedAt, markStudioGenerationSubmitted } from "../../../app/components/studio-ttfvi";

describe("Studio TTFVI correlation", () => {
  it("keeps each generation's submit time isolated for the matching result", () => {
    markStudioGenerationSubmitted("job-a", 1000);
    markStudioGenerationSubmitted("job-b", 2000);

    expect(getStudioGenerationSubmittedAt("job-a")).toBe(1000);
    expect(getStudioGenerationSubmittedAt("job-b")).toBe(2000);
    expect(getStudioGenerationSubmittedAt("missing")).toBeNull();
  });
});
