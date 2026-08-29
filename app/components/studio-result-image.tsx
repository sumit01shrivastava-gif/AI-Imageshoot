/**
 * A result image is deliberately responsible for its own first-visible
 * telemetry.  The image remains a normal `<img>` so browser decoding,
 * caching and progressive rendering are never delayed by analytics.
 */
export interface StudioResultImageProps {
  jobId: string;
  resultId: string;
  url: string;
  alt?: string;
}

function telemetryKey(jobId: string, resultId: string) {
  return `ai-imageshoot:ttfvi:${jobId}:${resultId}`;
}

export function StudioResultImage({ jobId, resultId, url, alt = "Generated result" }: StudioResultImageProps) {
  function reportVisible(event: { currentTarget: HTMLImageElement }) {
    // An image can dispatch `load` again when React remounts it after a
    // revalidation. Session storage makes this a single browser event per
    // durable result without putting any prompt, URL or image data in storage.
    const key = telemetryKey(jobId, resultId);
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Privacy-restricted browsers can deny session storage. Rendering must
      // stay completely independent of telemetry in that case.
      return;
    }

    const renderedAt = Date.now();
    const submittedAt = getStudioGenerationSubmittedAt(jobId);
    const performanceEntry = Array.from(performance.getEntriesByName(event.currentTarget.currentSrc))
      .reverse()
      .find((entry) => entry.entryType === "resource");
    const imageLoadStartedAt = performanceEntry
      ? Math.round(performance.timeOrigin + performanceEntry.startTime)
      : renderedAt;

    const body = new FormData();
    body.set("intent", "record-ttfvi");
    body.set("generationJobId", jobId);
    body.set("resultId", resultId);
    // Detection and load start are recorded separately even when browser
    // cache coalesces them into the same instant. The server never receives
    // the image URL, prompt, attachment or any provider metadata here.
    body.set("resultDetectedAt", String(imageLoadStartedAt));
    body.set("imageLoadStartedAt", String(imageLoadStartedAt));
    body.set("imageRenderedAt", String(renderedAt));
    if (submittedAt) body.set("userSubmitAt", String(submittedAt));
    void fetch(window.location.pathname, { method: "POST", body, credentials: "same-origin", keepalive: true });
  }

  return <img className="studio-turn-result" src={url} alt={alt} onLoad={reportVisible} />;
}
import { getStudioGenerationSubmittedAt } from "./studio-ttfvi";
