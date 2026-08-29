/**
 * Backward-compatible, derived progress stages. GenerationStatus remains the
 * durable lifecycle source of truth; this adds only truthful presentation
 * detail based on whether durable image results already exist.
 */
export type GenerationProgressStage = "PREPARING" | "PLANNING" | "QUEUED" | "GENERATING" | "CHECKING_QUALITY" | "COMPLETED" | "FAILED";

export function generationProgressStage(status: string, resultCount: number): GenerationProgressStage {
  if (status === "FAILED") return "FAILED";
  if (status === "SUCCEEDED") return "COMPLETED";
  if (resultCount > 0) return "CHECKING_QUALITY";
  if (status === "PROCESSING") return "GENERATING";
  if (status === "QUEUED") return "QUEUED";
  return "PREPARING";
}

export function isGenerationActiveStage(stage: GenerationProgressStage): boolean {
  return stage === "PREPARING" || stage === "PLANNING" || stage === "QUEUED" || stage === "GENERATING" || stage === "CHECKING_QUALITY";
}

/** A persisted result is always renderable, even while the job remains
 * PROCESSING for non-blocking Quality Director metadata. */
export function isResultRenderable(resultCount: number): boolean {
  return resultCount > 0;
}

/** Poll every active job in a conversation, not merely the first sorted row.
 * Rapid rows can tie on timestamps, so `jobs[0]` is not a safe liveness
 * authority for a multi-turn session. */
export function hasActiveGeneration(jobs: Array<{ progressStage: GenerationProgressStage }>): boolean {
  return jobs.some((job) => isGenerationActiveStage(job.progressStage));
}
