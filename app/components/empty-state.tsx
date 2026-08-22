import type { ReactNode } from "react";

/**
 * A designed, intentional empty state — replaces every bare "No data
 * found." with: what the user can do, why it matters, and a clear next
 * action. Used by the home dashboard, product history lists, and the
 * assets library. See CLAUDE.md's UI polish pass, Phase 9.
 */
export interface EmptyStateProps {
  icon?: string;
  title: string;
  body: string;
  action?: ReactNode;
  /** Optional "how it works" steps (home dashboard's first-run state). */
  steps?: string[];
}

export function EmptyState({ icon = "✨", title, body, action, steps }: EmptyStateProps) {
  return (
    <div className="aps-empty-state">
      <div className="aps-empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="aps-empty-state-title">{title}</p>
      <p className="aps-empty-state-body">{body}</p>
      {steps && steps.length > 0 && (
        <div className="aps-empty-state-steps">
          {steps.map((step, index) => (
            <div className="aps-empty-state-step" key={step}>
              <span className="aps-empty-state-step-number">{index + 1}</span>
              <span className="aps-empty-state-step-text">{step}</span>
            </div>
          ))}
        </div>
      )}
      {action}
    </div>
  );
}
