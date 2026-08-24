/**
 * AI Imageshoot's brand mark — two opposing corner-brackets pulling in on
 * a centered solid square, reading as "framing/transforming a subject"
 * without being a literal camera or a generic AI sparkle. Pure SVG,
 * strokes/fills always `currentColor` so it inherits whatever ink color
 * the surrounding element sets — legible on both the studio's dark and
 * light palettes with no separate light/dark asset needed. See
 * app/styles/studio.css's module doc comment for the brand direction.
 */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 13V5C4 4.44772 4.44772 4 5 4H13"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M28 19V27C28 27.5523 27.5523 28 27 28H19"
        stroke="currentColor"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="13" y="13" width="6" height="6" rx="1.25" fill="currentColor" />
    </svg>
  );
}

export interface LogoProps {
  /** "mark" — just the icon (sidebar-collapsed, favicon-style contexts).
   * "full" — icon + wordmark (auth pages, sidebar header). */
  variant?: "mark" | "full";
  size?: number;
  className?: string;
}

export function Logo({ variant = "full", size = 22, className }: LogoProps) {
  if (variant === "mark") return <LogoMark size={size} />;
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: size * 0.4 }}>
      <LogoMark size={size} />
      <span style={{ fontFamily: "var(--studio-font-display)", fontSize: size * 0.72, fontWeight: 600, letterSpacing: "-0.01em" }}>
        Imageshoot
      </span>
    </span>
  );
}
