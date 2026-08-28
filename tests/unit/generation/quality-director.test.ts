import { describe, expect, it } from "vitest";
import type { VisualQualityEvaluationRaw } from "../../../services/ai/types";
import { applyQualityPolicy, correctionPolicyFor, QUALITY_THRESHOLDS, VisualQualityEvaluationRawSchema, weightedQualityScore } from "../../../services/generation/quality-director";
import { DeterministicVisualQualityEvaluator } from "../../../services/generation/quality-evaluator.server";

const strong: VisualQualityEvaluationRaw = {
  dimensions: { productFidelity: 9, briefAdherence: 9, creativeConcept: 9, artDirection: 8.5, photographyRealism: 9, composition: 8.5, commercialUsefulness: 9, designExecution: 8, physicalIntegrity: 9, channelSuitability: 8.5 },
  criticalFailures: [], observations: ["Faithful product and coherent commercial execution."], correctionGuidance: [], confidence: 9,
};
function withScore(dimension: keyof VisualQualityEvaluationRaw["dimensions"], score: number): VisualQualityEvaluationRaw {
  return { ...strong, dimensions: { ...strong.dimensions, [dimension]: score } };
}

describe("post-generation Quality Director", () => {
  it("validates every dimension and rejects malformed evaluator results", () => {
    expect(VisualQualityEvaluationRawSchema.parse(strong).dimensions.productFidelity).toBe(9);
    expect(() => VisualQualityEvaluationRawSchema.parse({ ...strong, dimensions: { ...strong.dimensions, productFidelity: 11 } })).toThrow();
  });

  it("uses deliverable-aware weighting without making ecommerce creativity a failure", () => {
    const ecommerce = withScore("creativeConcept", 2);
    expect(applyQualityPolicy(ecommerce, "ECOMMERCE").verdict).toBe("PASS");
    expect(weightedQualityScore(ecommerce.dimensions, "ECOMMERCE")).toBeGreaterThan(8);
  });

  it("hard-fails a beautiful but wrong product", () => {
    const result = applyQualityPolicy({ ...withScore("productFidelity", 4), criticalFailures: ["PRODUCT_MISMATCH"] }, "CAMPAIGN");
    expect(result.verdict).toBe("HARD_FAIL");
    expect(result.overallScore).toBeGreaterThan(6);
  });

  it("fails an explicit brief contradiction and a model-contact failure", () => {
    expect(applyQualityPolicy({ ...strong, criticalFailures: ["BRIEF_CONTRADICTION"] }, "CAMPAIGN").verdict).toBe("HARD_FAIL");
    expect(applyQualityPolicy({ ...withScore("physicalIntegrity", 5), criticalFailures: ["PHYSICAL_INTEGRITY_FAILURE"] }, "MODEL_INTERACTION").verdict).toBe("HARD_FAIL");
  });

  it("marks generic campaign work borderline without punishing clean ecommerce", () => {
    const generic = applyQualityPolicy({ ...withScore("creativeConcept", 5), dimensions: { ...withScore("creativeConcept", 5).dimensions, artDirection: 5.5 } }, "CAMPAIGN");
    expect(generic.verdict).toBe("BORDERLINE");
    expect(applyQualityPolicy(withScore("creativeConcept", 2), "ECOMMERCE").verdict).toBe("PASS");
  });

  it("keeps correction bounded and disabled until it can be single-charge safe", () => {
    const policy = correctionPolicyFor(applyQualityPolicy({ ...withScore("composition", 6), correctionGuidance: ["Create a clearer copy-safe region."] }, "CAMPAIGN"));
    expect(policy).toMatchObject({ allowed: false, maxGenerationAttempts: 2 });
    expect(policy.guidance).toEqual(["Create a clearer copy-safe region."]);
  });

  it("provides a deterministic evaluator seam and propagates service errors", async () => {
    const evaluator = new DeterministicVisualQualityEvaluator(strong);
    await expect(evaluator.evaluate({ generatedImage: { data: new Uint8Array([1]), contentType: "image/png" }, references: [], qualityBrief: {} })).resolves.toEqual(strong);
    const failing = new DeterministicVisualQualityEvaluator(new Error("evaluator unavailable"));
    await expect(failing.evaluate({ generatedImage: { data: new Uint8Array([1]), contentType: "image/png" }, references: [], qualityBrief: {} })).rejects.toThrow("evaluator unavailable");
  });

  it("documents the commercial fidelity threshold centrally", () => {
    expect(QUALITY_THRESHOLDS.requiredProductFidelity).toBe(8);
  });
});
