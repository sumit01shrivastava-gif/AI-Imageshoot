/**
 * The standalone studio's "your image is being created" state — the
 * non-Shopify counterpart to app/components/generation-loading.tsx
 * (same honest-status principle, `.studio-*` classes instead of
 * `.aps-*`/Polaris so it fits the standalone design system). Never
 * claims a fabricated percentage — the three steps are illustrative
 * framing over the same real, discrete GenerationStatus lifecycle
 * (PENDING/QUEUED/PROCESSING) every other generation surface tracks.
 */
import { useEffect, useState } from "react";
import { generationProgressPresentation, type ActiveGenerationProgressStage } from "./studio-generation-progress";

export interface StudioGenerationLoadingProps {
  /** A concise stage heading supplied by the conversation turn. */
  title?: string;
  /** The real job stage. Never use a simulated percentage. */
  stage?: ActiveGenerationProgressStage;
}

export function StudioGenerationLoading({ title, stage = "QUEUED" }: StudioGenerationLoadingProps) {
  const presentation = generationProgressPresentation[stage];
  const copy = presentation.copy;
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (copy.length < 2) return;
    const id = window.setInterval(() => setPhraseIndex((index) => (index + 1) % copy.length), 3200);
    return () => window.clearInterval(id);
  }, [copy]);

  return (
    <div className="studio-generating" data-stage={stage} role="status" aria-live="polite">
      <div className="studio-generating-mark" aria-hidden="true"><span /></div>
      <div className="studio-generating-title">{title ?? presentation.title}</div>
      <p className="studio-generating-message" key={`${stage}-${phraseIndex}`}>{copy[phraseIndex % copy.length]}</p>
    </div>
  );
}
