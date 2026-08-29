import type { ComposerAttachment } from "./composer";

export interface PendingStudioTurn {
  id: string;
  content: string;
  attachments: ComposerAttachment[];
  submittedAt: number;
  generationJobId?: string;
  optimisticVisibleAt?: number;
  referencePreviewVisibleAt?: number;
}

export interface PersistedStudioMessage {
  role: string;
  generationJobId?: string | null;
}

/** A server-owned message replaces its local turn only after its job id is observed. */
export function isPendingStudioTurnReconciled(
  pending: PendingStudioTurn | null,
  messages: PersistedStudioMessage[],
): boolean {
  return Boolean(
    pending?.generationJobId &&
    messages.some((message) => message.role === "USER" && message.generationJobId === pending.generationJobId),
  );
}

/** Browser object URLs have a single clear owner and are released only once. */
export function releaseOptimisticAttachments(attachments: ComposerAttachment[]): void {
  for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
}
