type SpinnerSize = "sm" | "md" | "lg";

/** Rendered width/height in CSS pixels for each size. */
const SIZE_PX = { sm: 16, md: 24, lg: 32 } as const satisfies Record<SpinnerSize, number>;

interface SpinnerProps {
  readonly size?: SpinnerSize;
  readonly className?: string;
  /**
   * Decoration only: hidden from assistive technology and drawn in
   * `currentColor`, for a spinner inside a control that already reports
   * its busy state (a loading `Button` sets `aria-busy`).
   */
  readonly decorative?: boolean;
}

/**
 * SVG loading spinner. By default it is a "Loading" status (`<output>` with
 * visually hidden text) drawn in the plasma accent.
 *
 * The rotation is Tailwind's `animate-spin` (a stylesheet animation), so
 * the global reduced-motion override in animations.css stops it.
 */
export function Spinner({
  size = "md",
  className,
  decorative = false,
}: SpinnerProps): React.ReactElement {
  const px = SIZE_PX[size];
  const svg = (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="animate-spin"
    >
      <circle
        cx={12}
        cy={12}
        r={10}
        strokeWidth={2.5}
        className={decorative ? "stroke-current/25" : "stroke-plasma/25"}
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        strokeWidth={2.5}
        strokeLinecap="round"
        className={decorative ? "stroke-current" : "stroke-plasma"}
      />
    </svg>
  );
  const frame = `inline-flex leading-none ${className ?? ""}`;

  return decorative ? (
    <span aria-hidden="true" className={frame}>
      {svg}
    </span>
  ) : (
    <output className={frame}>
      <span className="sr-only">Loading</span>
      {svg}
    </output>
  );
}
