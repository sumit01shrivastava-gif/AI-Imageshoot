/**
 * Post-generation Quality Director.
 *
 * The visual evaluator supplies constrained observations. This module owns
 * the deterministic, deliverable-aware verdict so an attractive image cannot
 * mask a product, brief, or physical-integrity failure.
 */
import { z } from "zod";
import type { VisualQualityCriticalFailure, VisualQualityDimension, VisualQualityEvaluationRaw } from "../ai/types";
import type { GenerationPlan } from "./schema";

export const QUALITY_DIMENSIONS = [
  "productFidelity", "briefAdherence", "creativeConcept", "artDirection", "photographyRealism",
  "composition", "commercialUsefulness", "designExecution", "physicalIntegrity", "channelSuitability",
] as const satisfies readonly VisualQualityDimension[];

const scoreSchema = z.number().finite().min(0).max(10);
export const VisualQualityEvaluationRawSchema = z.object({
  dimensions: z.object(Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, scoreSchema])) as Record<VisualQualityDimension, typeof scoreSchema>),
  criticalFailures: z.array(z.enum(["PRODUCT_MISMATCH", "BRIEF_CONTRADICTION", "PHYSICAL_INTEGRITY_FAILURE", "FORMAT_FAILURE", "INVENTED_BRANDING_OR_TEXT"])).max(8),
  observations: z.array(z.string().trim().min(1).max(280)).max(8),
  correctionGuidance: z.array(z.string().trim().min(1).max(280)).max(6),
  confidence: scoreSchema,
  evaluatorMetadata: z.record(z.string(), z.unknown()).optional(),
});

export type QualityVerdict = "PASS" | "BORDERLINE" | "FAIL" | "HARD_FAIL" | "QUALITY_SERVICE_ERROR";

export interface QualityEvaluation {
  overallScore: number;
  verdict: QualityVerdict;
  dimensions: Record<VisualQualityDimension, number>;
  criticalFailures: VisualQualityCriticalFailure[];
  observations: string[];
  correctionGuidance: string[];
  confidence: number;
  evaluatorMetadata: Record<string, unknown>;
  qualityProfile: "ECOMMERCE" | "CAMPAIGN" | "MODEL_INTERACTION" | "EDIT";
}

export interface QualityServiceError {
  verdict: "QUALITY_SERVICE_ERROR";
  service: string;
  reason: string;
}

const BASE_WEIGHTS: Record<VisualQualityDimension, number> = {
  productFidelity: 0.2,
  briefAdherence: 0.1,
  creativeConcept: 0.1,
  artDirection: 0.1,
  photographyRealism: 0.1,
  composition: 0.1,
  commercialUsefulness: 0.1,
  designExecution: 0.05,
  physicalIntegrity: 0.05,
  channelSuitability: 0.1,
};

const ECOMMERCE_WEIGHTS: Record<VisualQualityDimension, number> = {
  productFidelity: 0.3, briefAdherence: 0.2, creativeConcept: 0.02, artDirection: 0.03,
  photographyRealism: 0.12, composition: 0.1, commercialUsefulness: 0.1, designExecution: 0.01,
  physicalIntegrity: 0.03, channelSuitability: 0.09,
};

const MODEL_WEIGHTS: Record<VisualQualityDimension, number> = {
  ...BASE_WEIGHTS, productFidelity: 0.22, physicalIntegrity: 0.13, composition: 0.08,
  creativeConcept: 0.07, artDirection: 0.08, channelSuitability: 0.07,
};

export const QUALITY_THRESHOLDS = {
  hardProductFidelity: 6,
  requiredProductFidelity: 8,
  requiredBriefAdherence: 8,
  requiredPhysicalIntegrityForModel: 8,
  failOverall: 6.5,
  passOverall: 8,
  passCriticalDimension: 8,
  borderlineCreativeForCampaign: 6.5,
} as const;

function weightsFor(profile: QualityEvaluation["qualityProfile"]): Record<VisualQualityDimension, number> {
  if (profile === "ECOMMERCE" || profile === "EDIT") return ECOMMERCE_WEIGHTS;
  if (profile === "MODEL_INTERACTION") return MODEL_WEIGHTS;
  return BASE_WEIGHTS;
}

export function weightedQualityScore(dimensions: Record<VisualQualityDimension, number>, profile: QualityEvaluation["qualityProfile"]): number {
  const score = QUALITY_DIMENSIONS.reduce((total, dimension) => total + dimensions[dimension] * weightsFor(profile)[dimension], 0);
  return Math.round(score * 10) / 10;
}

export function applyQualityPolicy(raw: VisualQualityEvaluationRaw, profile: QualityEvaluation["qualityProfile"]): QualityEvaluation {
  const parsed = VisualQualityEvaluationRawSchema.parse(raw);
  const { dimensions } = parsed;
  const overallScore = weightedQualityScore(dimensions, profile);
  const critical = new Set(parsed.criticalFailures);
  const hardFailure =
    critical.has("PRODUCT_MISMATCH") || critical.has("BRIEF_CONTRADICTION") || critical.has("PHYSICAL_INTEGRITY_FAILURE") ||
    dimensions.productFidelity < QUALITY_THRESHOLDS.hardProductFidelity;
  const requiredPhysical = profile === "MODEL_INTERACTION";
  const requiredGateFailed =
    dimensions.productFidelity < QUALITY_THRESHOLDS.requiredProductFidelity ||
    dimensions.briefAdherence < QUALITY_THRESHOLDS.requiredBriefAdherence ||
    (requiredPhysical && dimensions.physicalIntegrity < QUALITY_THRESHOLDS.requiredPhysicalIntegrityForModel) ||
    critical.has("FORMAT_FAILURE") || critical.has("INVENTED_BRANDING_OR_TEXT");
  const campaignUnderperforming = profile === "CAMPAIGN" &&
    (dimensions.creativeConcept < QUALITY_THRESHOLDS.borderlineCreativeForCampaign || dimensions.artDirection < QUALITY_THRESHOLDS.borderlineCreativeForCampaign);

  const verdict: QualityVerdict = hardFailure ? "HARD_FAIL" : requiredGateFailed || overallScore < QUALITY_THRESHOLDS.failOverall ? "FAIL" :
    campaignUnderperforming || overallScore < QUALITY_THRESHOLDS.passOverall || dimensions.commercialUsefulness < QUALITY_THRESHOLDS.passCriticalDimension ? "BORDERLINE" : "PASS";

  return {
    overallScore, verdict, dimensions: parsed.dimensions, criticalFailures: parsed.criticalFailures,
    observations: parsed.observations, correctionGuidance: parsed.correctionGuidance,
    confidence: parsed.confidence, evaluatorMetadata: parsed.evaluatorMetadata ?? {}, qualityProfile: profile,
  };
}

/** Produces only the evidence a vision critic needs; never sends raw prompts. */
export function buildQualityEvaluationBrief(plan: GenerationPlan): Record<string, unknown> {
  const blueprint = plan.creativeIntent?.creativeBrief?.creativeBlueprint;
  return {
    deliverable: blueprint?.brief.deliverableClass ?? plan.generationType,
    qualityProfile: blueprint?.qualityIntent.profile ?? "CAMPAIGN",
    productTruth: {
      identityAnchors: plan.productFacts.identityAnchors ?? null,
      sourceScenePolicy: blueprint?.productTruth.sourceScenePolicy ?? null,
      categoryFocus: blueprint?.productTruth.categoryFocus ?? [],
    },
    explicitConstraints: plan.creativeDirection.negativeConstraints ?? [],
    commercialObjective: blueprint?.commercialStrategy.objective ?? null,
    campaignConcept: blueprint?.creativeDirection.concept ?? null,
    artDirection: blueprint?.artDirection ?? null,
    photographyRequirements: blueprint?.photographyDirection ?? null,
    designRequirements: blueprint?.designDirection ?? null,
    campaignDNA: blueprint?.campaignDNA ?? null,
    aspectRatio: plan.aspectRatio,
    mode: plan.creativeIntent?.mode ?? null,
  };
}

export function qualityProfileForPlan(plan: GenerationPlan): QualityEvaluation["qualityProfile"] {
  return plan.creativeIntent?.creativeBrief?.creativeBlueprint?.qualityIntent.profile ?? "CAMPAIGN";
}

/** The contract is ready, but automatic correction stays disabled until it
 * can reuse a single reservation without a second merchant charge. */
export function correctionPolicyFor(evaluation: QualityEvaluation): { allowed: false; maxGenerationAttempts: 2; reason: string; guidance: string[] } {
  return {
    allowed: false,
    maxGenerationAttempts: 2,
    reason: evaluation.verdict === "PASS" ? "quality passed" : "automatic correction disabled until internal attempts can be settled against one billable reservation",
    guidance: evaluation.correctionGuidance,
  };
}
