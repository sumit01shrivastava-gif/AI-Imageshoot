/**
 * Unit test: lib/storage/resign.server.ts's `withResultsSanitizedForClient`
 * — the fix for a real internal-path leak (see that function's doc
 * comment): loaders were passing `storageKey` straight through to
 * `useLoaderData`/the client on every job-bearing route (product detail,
 * both batch review pages, store visual detail).
 */
import { describe, expect, it } from "vitest";
import { withResultsSanitizedForClient } from "../../../lib/storage/resign.server";

describe("withResultsSanitizedForClient", () => {
  it("removes storageKey from every result while preserving url and other fields", () => {
    const job = {
      id: "job1",
      status: "SUCCEEDED",
      results: [
        { id: "r1", storageKey: "shops/x/generation/job1/0.png", url: "/media/...", width: 1024, height: 1024 },
        { id: "r2", storageKey: "shops/x/generation/job1/1.png", url: "/media/...", width: 512, height: 512 },
      ],
    };

    const sanitized = withResultsSanitizedForClient(job);

    expect(sanitized.results).toHaveLength(2);
    for (const result of sanitized.results) {
      expect(result).not.toHaveProperty("storageKey");
    }
    expect(sanitized.results[0]).toMatchObject({ id: "r1", url: "/media/...", width: 1024, height: 1024 });
    expect(sanitized.results[1]).toMatchObject({ id: "r2", url: "/media/...", width: 512, height: 512 });
  });

  it("preserves every non-results field on the job untouched", () => {
    const job = { id: "job1", status: "SUCCEEDED", productId: "p1", results: [] as { storageKey: string; url: string | null }[] };
    const sanitized = withResultsSanitizedForClient(job);
    expect(sanitized).toMatchObject({ id: "job1", status: "SUCCEEDED", productId: "p1" });
  });

  it("handles a job with no results", () => {
    const job = { id: "job1", results: [] as { storageKey: string; url: string | null }[] };
    expect(withResultsSanitizedForClient(job).results).toEqual([]);
  });

  it("serializes cleanly (no leftover storageKey survives a JSON round-trip)", () => {
    const job = {
      id: "job1",
      results: [{ id: "r1", storageKey: "shops/x/a.png", url: "/media/a" }],
    };
    const serialized = JSON.stringify(withResultsSanitizedForClient(job));
    expect(serialized).not.toContain("storageKey");
    expect(serialized).not.toContain("shops/x/a.png");
  });
});
