interface StugaMarkProps {
  className?: string;
}

/**
 * The Stuga cottage: a simple roof, a round window, and an open door.
 * Geometry carries the idea, so the mark remains recognisable without colour.
 */
export function StugaMark({ className = "" }: StugaMarkProps) {
  return (
    <svg
      className={`stuga-mark ${className}`.trim()}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="stuga-mark-tile" width="40" height="40" rx="3" />
      <path className="stuga-mark-house" d="M6 18.5 20 6l14 12.5V34H6Z" />
      <circle className="stuga-mark-window" cx="20" cy="18.5" r="4" />
      <path className="stuga-mark-door" d="M17 25h6v9h-6z" />
    </svg>
  );
}
