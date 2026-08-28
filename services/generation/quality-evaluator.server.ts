/** Resolver and safe boundary for post-generation visual evaluation. */
import { getEnv } from "../../lib/validation/env.server";
import type { VisualQualityEvaluationInput, VisualQualityEvaluationRaw, VisualQualityEvaluator } from "../ai/types";
import { OpenAIVisualQualityEvaluator } from "../ai/openai-visual-quality-evaluator.server";

export class QualityServiceUnavailableError extends Error {
  constructor(message = "No visual quality evaluator is configured.") { super(message); this.name = "QualityServiceUnavailableError"; }
}

export class UnconfiguredVisualQualityEvaluator implements VisualQualityEvaluator {
  readonly name = "unconfigured-quality-evaluator";
  async evaluate(_input: VisualQualityEvaluationInput): Promise<VisualQualityEvaluationRaw> {
    void _input;
    throw new QualityServiceUnavailableError();
  }
}

/** Test seam: callers can inject a controlled evaluator without any network. */
export class DeterministicVisualQualityEvaluator implements VisualQualityEvaluator {
  readonly name = "deterministic-visual-quality";
  constructor(private readonly result: VisualQualityEvaluationRaw | Error) {}
  async evaluate(_input: VisualQualityEvaluationInput): Promise<VisualQualityEvaluationRaw> {
    void _input;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

export function getConfiguredVisualQualityEvaluator(): VisualQualityEvaluator {
  const env = getEnv();
  if (env.AI_PROVIDER === "openai" && env.AI_PROVIDER_API_KEY) return new OpenAIVisualQualityEvaluator();
  return new UnconfiguredVisualQualityEvaluator();
}
