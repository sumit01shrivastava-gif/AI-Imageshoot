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
  const snapshotById = new Map(snapshotJobs.map((job) => [job.id, job]));
  const merged = loaderJobs.map((previous) => {
    const snapshot = snapshotById.get(previous.id);
    if (!snapshot) return previous;
    if (snapshot.results.length > 0) return snapshot;
    return { ...snapshot, results: previous.results };
  });
  // A snapshot can begin after an action-created job but before its loader
  // response arrives. Preserve that new snapshot job too, in its status
  // response order, rather than making a newer turn disappear.
  for (const snapshot of snapshotJobs) {
    if (!previousById.has(snapshot.id)) merged.push(snapshot);
  }
  return merged;
}
