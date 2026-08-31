import { describe, expect, it } from "vitest";
import { mergeStudioJobSnapshots } from "../../../app/components/studio-job-snapshot";

describe("Studio active-job snapshots", () => {
  it("surfaces a newly persisted active result without waiting for terminal status", () => {
    const merged = mergeStudioJobSnapshots(
      [{ id: "job-1", status: "PROCESSING", results: [] }],
      [{ id: "job-1", status: "PROCESSING", results: [{ id: "result-1" }] }],
    );
    expect(merged).toEqual([{ id: "job-1", status: "PROCESSING", results: [{ id: "result-1" }] }]);
  });

  it("does not erase an already rendered result when a terminal status snapshot omits historical URLs", () => {
    const merged = mergeStudioJobSnapshots(
      [{ id: "job-1", status: "PROCESSING", results: [{ id: "result-1" }] }],
      [{ id: "job-1", status: "SUCCEEDED", results: [] }],
    );
    expect(merged).toEqual([{ id: "job-1", status: "SUCCEEDED", results: [{ id: "result-1" }] }]);
  });

  it("keeps separate jobs isolated across concurrent turns", () => {
    const merged = mergeStudioJobSnapshots(
      [
        { id: "older", status: "SUCCEEDED", results: [{ id: "old-result" }] },
        { id: "active", status: "PROCESSING", results: [] },
      ],
      [
        { id: "active", status: "PROCESSING", results: [{ id: "new-result" }] },
        { id: "older", status: "SUCCEEDED", results: [] },
      ],
    );
    expect(merged[0]?.results).toEqual([{ id: "new-result" }]);
    expect(merged[1]?.results).toEqual([{ id: "old-result" }]);
  });
});
