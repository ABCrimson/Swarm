type SpinnerSize = "sm" | "md" | "lg";

/** Rendered width/height in CSS pixels for each size. */
const SIZE_PX = { sm: 16, md: 24, lg: 32 } as const satisfies Record<SpinnerSize, number>;

interface SpinnerProps {
  readonly size?: SpinnerSize;
  readonly className?: string;
}

/**
 * OKLCH-themed SVG loading spinner, announced as a "Loading" status.
 *
 * The rotation is Tailwind's `animate-spin` (a stylesheet animation), so
 * the global reduced-motion override in animations.css stops it.
 */
export function Spinner({ size = "md", className }: SpinnerProps): React.ReactElement {
  const px = SIZE_PX[size];

  return (
    <output aria-label="Loading" className={`inline-flex leading-none ${className ?? ""}`}>
      <svg
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="animate-spin"
      >
        <circle cx={12} cy={12} r={10} strokeWidth={2.5} className="stroke-plasma/25" />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          strokeWidth={2.5}
          strokeLinecap="round"
          className="stroke-plasma"
        />
      </svg>
    </output>
  );
}
