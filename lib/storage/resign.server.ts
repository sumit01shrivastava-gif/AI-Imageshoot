/**
 * Fresh-signing helper — closes a real, previously-undetected bug: every
 * `*Result` row (`GenerationResult`/`ProcessingResult`/`StoreVisualResult`)
 * stores a `url` that was signed ONCE, at creation time, for one hour
 * (see each domain's job.server.ts's `persistOutput`). Any read path that
 * returns that stored `.url` as-is to a merchant is showing a broken
 * image for any result older than an hour — which every history/review
 * page (product detail generation/processing history, batch review
 * pages, store visual detail, and the Asset Library) can trivially
 * surface just by being viewed more than an hour after a result was
 * created. `storageKey` itself never expires, so the fix is always to
 * re-sign fresh from it at read time rather than trust the stored value.
 *
 * Used by every domain's read-side service functions (getGeneration/
 * listGenerationHistory/getGenerationBatchSummary,
 * getProcessing/listProcessingHistory/getBatchSummary,
 * getStoreVisual/listStoreVisualHistory) and by
 * services/assets/asset-library.server.ts. Not used by the write-side
 * `persistOutput` functions themselves — the URL stored at creation time
 * is still meaningful as an immediate, one-shot convenience (e.g. a
 * BullMQ job's return value), it's just never trusted again after that.
 */
import { getConfiguredStorageProvider } from "./provider.server";

/** Matches `SIGNED_URL_TTL_SECONDS` used by each domain's job.server.ts's
 * `persistOutput` at write time — kept in sync here since read-time
 * re-signing uses the same lifetime. */
const SIGNED_URL_TTL_SECONDS = 3600;

export interface ResignableResult {
  storageKey: string;
  url: string | null;
}

/** Re-signs `.url` fresh from `.storageKey` for every result in `results`,
 * in parallel, preserving every other field untouched. Safe to call on an
 * empty array. A storage-provider failure (e.g. local filesystem
 * misconfiguration) propagates — callers already handle a thrown error
 * from a service-layer read the same way any other unexpected failure is
 * handled (CLAUDE.md "Safe error handling"). */
export async function resignResultUrls<T extends ResignableResult>(results: T[]): Promise<T[]> {
  if (results.length === 0) return results;
  const storage = getConfiguredStorageProvider();
  return Promise.all(
    results.map(async (result) => ({
      ...result,
      url: await storage.getSignedUrl({ key: result.storageKey, expiresInSeconds: SIGNED_URL_TTL_SECONDS, operation: "get" }),
    })),
  );
}

/**
 * Strips `storageKey` from every result on a job before it reaches
 * `useLoaderData`/the client — a real, previously-undetected leak: every
 * `*JobRow`'s `results` selection (see each domain's
 * db/repositories/*-job.repository.ts's `RESULT_SELECT`) includes
 * `storageKey` because the SERVER needs it (to resign a fresh URL — see
 * `resignResultUrls` above); loaders that pass a whole job straight
 * through to their component (product detail's generation/processing
 * history, the batch review pages, store visual detail) were embedding
 * that internal storage path — e.g. `shops/{shop}/generation/{jobId}/0.png`
 * — into the page's client-visible loader data. `url` (the actual signed,
 * fetchable reference) is untouched; only the raw key is removed. See
 * CLAUDE.md "Storage rules"/"no internal-path exposure in result
 * metadata".
 *
 * Cast back to `J` rather than an `Omit<...>` type: every call site's
 * component tree already types its job prop as the full `*JobRow` (e.g.
 * `GenerationJobRow`) and never reads `.storageKey` from it, so
 * threading a narrower type through would be a larger, purely-cosmetic
 * refactor for no behavioral benefit — the field is genuinely absent at
 * runtime after this call, which is what actually matters here.
 */
export function withResultsSanitizedForClient<J extends { results: ResignableResult[] }>(job: J): J {
  return {
    ...job,
    results: job.results.map((result) => {
      const sanitized: Record<string, unknown> = { ...result };
      delete sanitized.storageKey;
      return sanitized;
    }),
  } as J;
}
