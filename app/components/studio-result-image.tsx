/**
 * A result image owns only browser-side observation. Rendering remains a
 * normal `<img>`; telemetry is best effort and can never delay a result.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { studioLatencyEventKey, type StudioLatencyEvent } from "./studio-ttfvi";

export interface StudioResultImageProps {
  jobId: string;
  resultId: string;
  url: string;
  alt?: string;
  onTelemetry?: (event: StudioLatencyEvent, metadata?: Record<string, number>) => void;
}

export function StudioResultImage({ jobId, resultId, url, alt = "Generated result", onTelemetry }: StudioResultImageProps) {
  const emittedEventsRef = useRef(new Set<StudioLatencyEvent>());

  const emit = useCallback((event: StudioLatencyEvent, metadata?: Record<string, number>) => {
    if (emittedEventsRef.current.has(event)) return;
    const key = studioLatencyEventKey(event, jobId, resultId);
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      // Privacy-restricted browsers can deny storage. The mounted-image ref
      // still prevents duplicates, and rendering stays independent of this.
    }
    emittedEventsRef.current.add(event);
    onTelemetry?.(event, metadata);
  }, [jobId, onTelemetry, resultId]);

  // React has committed a durable result. This is intentionally separate
  // from loading the actual asset below.
  useEffect(() => {
    emit("RESULT_DETECTED");
  }, [emit]);

  // The request may begin once the image is committed. It remains observable
  // for cached and cross-origin images where Resource Timing is unavailable.
  useLayoutEffect(() => {
    emit("IMAGE_LOAD_START");
  }, [emit]);

  function reportLoaded(event: { currentTarget: HTMLImageElement }) {
    emit("IMAGE_LOADED");
    const performanceEntry = Array.from(performance.getEntriesByName(event.currentTarget.currentSrc))
      .reverse()
      .find((entry) => entry.entryType === "resource");
    const resourceDurationMs = performanceEntry ? Math.round(performanceEntry.duration) : undefined;
    // Decode followed by a paint frame is a safe approximation of first
    // visible pixels without blocking the browser's image pipeline.
    void event.currentTarget.decode().catch(() => undefined).finally(() => {
      requestAnimationFrame(() => emit("IMAGE_RENDERED", resourceDurationMs ? { resourceDurationMs } : undefined));
    });
  }

  return <img className="studio-turn-result" src={url} alt={alt} onLoad={reportLoaded} />;
}
