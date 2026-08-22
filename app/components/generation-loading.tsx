/**
 * A polished "your image is being created" state — replaces a bare
 * spinner/"Loading…" text wherever a generation is in flight (Creative
 * Studio, product imagery, store visuals). Deliberately does NOT claim a
 * fake percentage — the three "steps" are illustrative framing over the
 * SAME honest, discrete status the app already tracks
 * (PENDING/QUEUED/PROCESSING), not a fabricated progress bar. See
 * CLAUDE.md's UI polish pass — "Do not fake AI generation progress."
 */
const STEPS = ["Preparing composition", "Applying your creative direction", "Rendering the final image"] as const;

export interface GenerationLoadingProps {
  /** A short, honest status line — e.g. "Creating your image…" or
   * "Generating 3 variations…" (see jobStatusPhrase-style callers). */
  title: string;
  /** Which of the three illustrative steps to highlight — derived from
   * the real job status, not a timer: 0 while PENDING/QUEUED (still
   * being understood/queued), 1–2 while PROCESSING (the only phase we
   * can't subdivide further without inventing progress that isn't
   * real, so it settles on step 2). */
  activeStep?: 0 | 1 | 2;
}

export function GenerationLoading({ title, activeStep = 1 }: GenerationLoadingProps) {
  return (
    <div className="aps-generating" role="status" aria-live="polite">
      <div className="aps-generating-orb" aria-hidden="true" />
      <div className="aps-generating-title">{title}</div>
      <div className="aps-generating-steps">
        {STEPS.map((step, index) => (
          <span key={step} className="aps-generating-step" data-active={index <= activeStep}>
            {step}
          </span>
        ))}
      </div>
    </div>
  );
}
