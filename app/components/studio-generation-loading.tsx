/**
 * The standalone studio's "your image is being created" state — the
 * non-Shopify counterpart to app/components/generation-loading.tsx
 * (same honest-status principle, `.studio-*` classes instead of
 * `.aps-*`/Polaris so it fits the standalone design system). Never
 * claims a fabricated percentage — the three steps are illustrative
 * framing over the same real, discrete GenerationStatus lifecycle
 * (PENDING/QUEUED/PROCESSING) every other generation surface tracks.
 */
// Deliberately maps only the discrete job lifecycle exposed by the backend.
// Do not rotate invented behind-the-scenes messages here: a calm static
// explanation is more trustworthy than implying provider activity we cannot
// observe directly.
const STATUS_SUPPORTING_COPY = [
  "Your request is queued and ready to begin.",
  "ImageShoot is actively creating this result.",
  "The result is being finalized for this conversation.",
] as const;

export interface StudioGenerationLoadingProps {
  title: string;
  activeStep?: 0 | 1 | 2;
}

export function StudioGenerationLoading({ title, activeStep = 1 }: StudioGenerationLoadingProps) {
  return (
    <div className="studio-generating" role="status" aria-live="polite">
      <div className="studio-generating-orb" aria-hidden="true" />
      <div className="studio-generating-title">{title}</div>
      <p className="studio-generating-message">{STATUS_SUPPORTING_COPY[activeStep]}</p>
      <div className="studio-generating-steps" aria-hidden="true">
        <span className="studio-generating-step" data-active={activeStep >= 0}>Request received</span>
        <span className="studio-generating-step" data-active={activeStep >= 1}>In progress</span>
        <span className="studio-generating-step" data-active={activeStep >= 2}>Finalizing</span>
      </div>
    </div>
  );
}
