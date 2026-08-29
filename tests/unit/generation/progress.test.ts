import { describe, expect, it } from "vitest";
import { generationProgressStage, hasActiveGeneration, isGenerationActiveStage, isResultRenderable } from "../../../services/generation/progress";

describe("derived generation progress", () => {
  it("maps durable lifecycle and persisted result availability to truthful stages", () => {
    expect(generationProgressStage("PENDING", 0)).toBe("PREPARING");
    expect(generationProgressStage("QUEUED", 0)).toBe("QUEUED");
    expect(generationProgressStage("PROCESSING", 0)).toBe("GENERATING");
    expect(generationProgressStage("PROCESSING", 1)).toBe("CHECKING_QUALITY");
    expect(generationProgressStage("SUCCEEDED", 1)).toBe("COMPLETED");
    expect(generationProgressStage("FAILED", 1)).toBe("FAILED");
  });

  it("keeps active polling limited to active work", () => {
    expect(isGenerationActiveStage("CHECKING_QUALITY")).toBe(true);
    expect(isGenerationActiveStage("COMPLETED")).toBe(false);
    expect(isGenerationActiveStage("FAILED")).toBe(false);
  });

  it("treats a persisted result as renderable regardless of non-blocking quality status", () => {
    expect(isResultRenderable(1)).toBe(true);
    expect(generationProgressStage("PROCESSING", 1)).toBe("CHECKING_QUALITY");
    expect(isResultRenderable(0)).toBe(false);
  });

  it("continues polling when any conversation job is active, even if the first row is terminal", () => {
    expect(hasActiveGeneration([{ progressStage: "COMPLETED" }, { progressStage: "GENERATING" }])).toBe(true);
    expect(hasActiveGeneration([{ progressStage: "COMPLETED" }, { progressStage: "FAILED" }])).toBe(false);
  });
});
