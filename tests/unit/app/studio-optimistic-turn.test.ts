import { describe, expect, it, vi } from "vitest";
import { isPendingStudioTurnReconciled, releaseOptimisticAttachments, type PendingStudioTurn } from "../../../app/components/studio-optimistic-turn";

const pending: PendingStudioTurn = {
  id: "local-1",
  content: "Create a campaign",
  submittedAt: 1,
  generationJobId: "job-1",
  attachments: [{ file: {} as File, previewUrl: "blob:reference" }],
};

describe("optimistic Studio turns", () => {
  it("keeps a local attachment until the matching persisted user turn arrives", () => {
    expect(isPendingStudioTurnReconciled(pending, [])).toBe(false);
    expect(isPendingStudioTurnReconciled(pending, [{ role: "USER", generationJobId: "other-job" }])).toBe(false);
    expect(isPendingStudioTurnReconciled(pending, [{ role: "USER", generationJobId: "job-1" }])).toBe(true);
  });

  it("releases local object URLs only when its owner reconciles or disposes", () => {
    const revoke = vi.fn();
    vi.stubGlobal("URL", { revokeObjectURL: revoke });
    releaseOptimisticAttachments(pending.attachments);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:reference");
    vi.unstubAllGlobals();
  });
});
