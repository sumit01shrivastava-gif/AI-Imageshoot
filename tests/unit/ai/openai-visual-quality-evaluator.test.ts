import { describe, expect, it } from "vitest";
import { resolveQualityEvaluationModel } from "../../../services/ai/openai-visual-quality-evaluator.server";

describe("OpenAI visual quality evaluator model selection", () => {
  it("uses its dedicated structured-output vision default instead of inheriting the image generation model", () => {
    expect(resolveQualityEvaluationModel({})).toBe("gpt-4o-mini");
  });

  it("allows an explicit compatible quality evaluator model override", () => {
    expect(resolveQualityEvaluationModel({ AI_PROVIDER_QUALITY_MODEL: "gpt-4o" })).toBe("gpt-4o");
  });
});
