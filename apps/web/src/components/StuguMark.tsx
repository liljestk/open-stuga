interface StuguMarkProps {
  className?: string;
}

/**
 * The Stugu cottage: a simple roof, a round window, and an open door.
 * Geometry carries the idea, so the mark remains recognisable without colour.
 */
export function StuguMark({ className = "" }: StuguMarkProps) {
  return (
    <svg
      className={`stugu-mark ${className}`.trim()}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="stugu-mark-tile" width="40" height="40" rx="3" />
      <path className="stugu-mark-house" d="M6 18.5 20 6l14 12.5V34H6Z" />
      <circle className="stugu-mark-window" cx="20" cy="18.5" r="4" />
      <path className="stugu-mark-door" d="M17 25h6v9h-6z" />
    </svg>
  );
}
