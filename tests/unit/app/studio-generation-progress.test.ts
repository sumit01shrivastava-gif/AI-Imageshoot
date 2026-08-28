import { describe, expect, it } from "vitest";
import { generationProgressPresentation } from "../../../app/components/studio-generation-progress";

describe("Studio generation progress presentation", () => {
  it("maps only real active lifecycle stages to merchant-safe progress", () => {
    expect(Object.keys(generationProgressPresentation)).toEqual(["PREPARING", "PLANNING", "QUEUED", "GENERATING", "CHECKING_QUALITY"]);
    expect(generationProgressPresentation.GENERATING.copy).toContain("Building the campaign world…");
    expect(generationProgressPresentation.CHECKING_QUALITY.title).toBe("Checking the finished image…");
  });

  it("uses qualitative stages rather than fabricated percentage progress", () => {
    for (const presentation of Object.values(generationProgressPresentation)) {
      expect(presentation.copy.join(" ")).not.toMatch(/\d+%/);
      expect(presentation.step).toBeGreaterThanOrEqual(0);
      expect(presentation.step).toBeLessThanOrEqual(2);
    }
  });
});
