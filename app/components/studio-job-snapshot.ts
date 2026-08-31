/**
 * Merges a short-lived active-job snapshot over loader data. Empty snapshot
 * results mean "unchanged historical URLs omitted", never "delete a durable
 * result". That makes an active result immediately visible while preserving
 * the chronological transcript until the canonical loader catches up.
 */
export function mergeStudioJobSnapshots<T extends { id: string; results: unknown[] }>(
  loaderJobs: T[],
  snapshotJobs: T[],
): T[] {
  const previousById = new Map(loaderJobs.map((job) => [job.id, job]));
  return snapshotJobs.map((snapshot) => {
    const previous = previousById.get(snapshot.id);
    if (!previous || snapshot.results.length > 0) return snapshot;
    return { ...snapshot, results: previous.results };
  });
}
