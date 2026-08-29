/** Browser-only, ephemeral correlation between a submitted turn and its job. */
const submittedAtByJob = new Map<string, number>();

export function markStudioGenerationSubmitted(jobId: string, submittedAt: number): void {
  submittedAtByJob.set(jobId, submittedAt);
}

export function getStudioGenerationSubmittedAt(jobId: string): number | null {
  return submittedAtByJob.get(jobId) ?? null;
}
