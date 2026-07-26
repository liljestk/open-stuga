interface StugubyMarkProps {
  className?: string;
}

/** Three close cottages, using the same elementary forms as the Stugu mark. */
export function StugubyMark({ className = "" }: StugubyMarkProps) {
  return (
    <svg
      className={`stuguby-mark ${className}`.trim()}
      viewBox="0 0 56 40"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="stuguby-mark-tile" width="56" height="40" rx="3" />
      <path className="stuguby-mark-house" d="M3 21 12 12l9 9v13H3Z" />
      <path className="stuguby-mark-house" d="M18 17 28 7l10 10v17H18Z" />
      <path className="stuguby-mark-house" d="M35 21 44 12l9 9v13H35Z" />
      <circle className="stuguby-mark-window" cx="12" cy="22" r="2.5" />
      <circle className="stuguby-mark-window" cx="28" cy="19" r="3" />
      <circle className="stuguby-mark-window" cx="44" cy="22" r="2.5" />
      <path className="stuguby-mark-door" d="M9.5 28h5v6h-5zM25 26h6v8h-6zM41.5 28h5v6h-5z" />
    </svg>
  );
}
