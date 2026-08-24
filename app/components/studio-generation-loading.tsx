/**
 * The standalone studio's "your image is being created" state — the
 * non-Shopify counterpart to app/components/generation-loading.tsx
 * (same honest-status principle, `.studio-*` classes instead of
 * `.aps-*`/Polaris so it fits the standalone design system). Never
 * claims a fabricated percentage — the three steps are illustrative
 * framing over the same real, discrete GenerationStatus lifecycle
 * (PENDING/QUEUED/PROCESSING) every other generation surface tracks.
 */
const STEPS = ["Preparing composition", "Applying your creative direction", "Rendering the final image"] as const;

export interface StudioGenerationLoadingProps {
  title: string;
  activeStep?: 0 | 1 | 2;
}

export function StudioGenerationLoading({ title, activeStep = 1 }: StudioGenerationLoadingProps) {
  return (
    <div className="studio-generating" role="status" aria-live="polite">
      <div className="studio-generating-orb" aria-hidden="true" />
      <div className="studio-generating-title">{title}</div>
      <div className="studio-generating-steps">
        {STEPS.map((step, index) => (
          <span key={step} className="studio-generating-step" data-active={index <= activeStep}>
            {step}
          </span>
        ))}
      </div>
    </div>
  );
}
