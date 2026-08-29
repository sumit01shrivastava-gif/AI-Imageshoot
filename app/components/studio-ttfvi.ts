/**
 * Small browser-safe timing primitives for Studio observability. They are
 * intentionally pure: ownership and de-duplication stay in the React turn
 * that observed the event, rather than in a shared mutable module cache.
 */
export const STUDIO_LATENCY_EVENTS = [
  "USER_SUBMITTED",
  "OPTIMISTIC_TURN_VISIBLE",
  "REFERENCE_PREVIEW_VISIBLE",
  "PERSISTED_TURN_VISIBLE",
  "RESULT_DETECTED",
  "IMAGE_LOAD_START",
  "IMAGE_LOADED",
  "IMAGE_RENDERED",
  "QUALITY_TERMINAL_OBSERVED",
  "LOADER_COMPLETED",
] as const;

export type StudioLatencyEvent = (typeof STUDIO_LATENCY_EVENTS)[number];

export function studioLatencyEventKey(
  event: StudioLatencyEvent,
  generationJobId?: string | null,
  resultId?: string | null,
): string {
  return `ai-imageshoot:studio-latency:${event}:${generationJobId ?? "session"}:${resultId ?? "turn"}`;
}

export function isStudioLatencyEvent(value: string): value is StudioLatencyEvent {
  return (STUDIO_LATENCY_EVENTS as readonly string[]).includes(value);
}
