/**
 * The standalone studio's message composer — text + image attachments,
 * shared between the "start a new conversation" landing screen
 * (studio._index.tsx) and an existing conversation's follow-up input
 * (studio.c.$sessionId.tsx). Purely a controlled input component: it
 * validates/previews attachments client-side and hands the parent route
 * a plain `(message, files)` pair to submit — it does not know about
 * CreativeSession/GenerationJob/fetchers itself, so both call sites stay
 * free to submit however fits their own action (new session vs. an
 * existing one).
 *
 * Upload path: files are read as `Uint8Array` server-side (see each
 * route's action) and passed to
 * services/creative-studio/reference-images.server.ts's
 * `uploadReferenceImages`, which stores them through the existing
 * StorageProvider abstraction — no parallel storage system.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface ComposerAttachment {
  file: File;
  previewUrl: string;
}

export interface ComposerProps {
  placeholder?: string;
  disabled?: boolean;
  /** True while a request is actually in flight — disables the send
   * button and shows it as busy without touching the text/attachments,
   * so the draft survives a slow response. */
  busy?: boolean;
  onSubmit: (message: string, files: File[], submittedAt: number) => void;
  /**
   * Lets a conversation keep browser-owned preview URLs alive in its
   * optimistic turn after submission. The caller takes ownership of those
   * URLs and must revoke them after persisted reconciliation or unmount.
   */
  onSubmitWithAttachments?: (message: string, attachments: ComposerAttachment[], submittedAt: number) => void;
}

/** Imperative handle so a parent can fill the draft from a suggestion
 * chip without duplicating the composer's own text state. */
export interface ComposerHandle {
  fill: (text: string) => void;
}

function validateFile(file: File): string | null {
  if (!ALLOWED_TYPES.has(file.type)) return `"${file.name}" isn't a supported image format (PNG, JPEG, or WebP only).`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `"${file.name}" is too large — images must be under 8MB.`;
  return null;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer({ placeholder, disabled, busy, onSubmit, onSubmitWithAttachments }, ref) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const ownedAttachmentsRef = useRef<ComposerAttachment[]>([]);

  function updateAttachments(updater: (current: ComposerAttachment[]) => ComposerAttachment[]) {
    setAttachments((current) => {
      const next = updater(current);
      ownedAttachmentsRef.current = next;
      return next;
    });
  }

  useEffect(() => () => {
    // Pre-submit previews remain Composer-owned. Post-submit previews are
    // explicitly transferred to the optimistic conversation turn below.
    ownedAttachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  }, []);

  useImperativeHandle(ref, () => ({
    fill(text: string) {
      setDraft(text);
      textareaRef.current?.focus();
    },
  }));

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;

    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }

    const accepted: ComposerAttachment[] = [];
    let firstError: string | null = null;
    for (const file of incoming.slice(0, room)) {
      const issue = validateFile(file);
      if (issue) {
        firstError = firstError ?? issue;
        continue;
      }
      accepted.push({ file, previewUrl: URL.createObjectURL(file) });
    }

    if (accepted.length > 0) updateAttachments((current) => [...current, ...accepted]);
    setError(firstError);
  }

  function removeAttachment(index: number) {
    updateAttachments((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }

  function handleSubmit() {
    const trimmed = draft.trim();
    if (disabled || busy) return;
    if (trimmed.length === 0 && attachments.length === 0) {
      setError("Describe what you want, or attach an image to start from.");
      return;
    }
    const submittedAt = Date.now();
    if (onSubmitWithAttachments) {
      // Transfer ownership of preview URLs to the optimistic conversation
      // turn. Clearing Composer state must not revoke them first.
      onSubmitWithAttachments(trimmed, attachments, submittedAt);
      ownedAttachmentsRef.current = [];
    } else {
      onSubmit(trimmed, attachments.map((a) => a.file), submittedAt);
      attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    }
    setDraft("");
    setAttachments([]);
    setError(null);
  }

  return (
    <div>
      <div
        className="studio-composer"
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.items)
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((f): f is File => f !== null);
          if (files.length > 0) addFiles(files);
        }}
      >
        {attachments.length > 0 && (
          <div className="studio-composer-attachments">
            {attachments.map((attachment, index) => (
              <div key={attachment.previewUrl} className="studio-attachment">
                <img src={attachment.previewUrl} alt="Attached reference" />
                <button
                  type="button"
                  className="studio-attachment-remove"
                  aria-label="Remove attachment"
                  onClick={() => removeAttachment(index)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="studio-composer-row">
          <button
            type="button"
            className="studio-composer-btn"
            aria-label="Attach an image"
            title="Attach an image"
            disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            rows={1}
            aria-label="Describe what you want to create"
            placeholder={placeholder ?? "Describe what you want to create…"}
            value={draft}
            disabled={disabled}
            onInput={(e) => {
              const el = e.currentTarget;
              setDraft(el.value);
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <button
            type="button"
            className="studio-send-btn"
            aria-label="Send"
            disabled={disabled || busy || (draft.trim().length === 0 && attachments.length === 0)}
            onClick={handleSubmit}
          >
            {busy ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" strokeDasharray="26" strokeDashoffset="8" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>
        <p className="studio-composer-guidance" aria-hidden="true">Attach a reference, then describe the creative direction.</p>
      </div>
      {error && <p className="studio-composer-error">{error}</p>}
    </div>
  );
});
