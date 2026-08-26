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

// These are intentionally atmospheric, not claims about hidden provider
// reasoning or a fabricated percentage. They make a real in-flight job feel
// active while preserving the discrete queue status as the source of truth.
const CREATIVE_MESSAGES = [
  "Your creative direction is taking shape…",
  "Bringing the visual language together…",
  "Refining the frame and atmosphere…",
  "The image is coming into view…",
] as const;

export interface StudioGenerationLoadingProps {
  title: string;
  activeStep?: 0 | 1 | 2;
}

export function StudioGenerationLoading({ title, activeStep = 1 }: StudioGenerationLoadingProps) {
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => setMessageIndex((index) => (index + 1) % CREATIVE_MESSAGES.length), 2600);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="studio-generating" role="status" aria-live="polite">
      <div className="studio-generating-orb" aria-hidden="true" />
      <div className="studio-generating-title">{title}</div>
      <p className="studio-generating-message" key={messageIndex}>{CREATIVE_MESSAGES[messageIndex]}</p>
      <div className="studio-generating-steps" aria-hidden="true">
        <span className="studio-generating-step" data-active={activeStep >= 0}>Request received</span>
        <span className="studio-generating-step" data-active={activeStep >= 1}>In progress</span>
        <span className="studio-generating-step" data-active={activeStep >= 2}>Finalizing</span>
      </div>
    </div>
  );
}
