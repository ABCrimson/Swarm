import { useEffect, useRef } from "react";

type SpinnerSize = "sm" | "md" | "lg";

const sizeMap: Record<SpinnerSize, number> = {
  sm: 16,
  md: 24,
  lg: 32,
};

interface SpinnerProps {
  readonly size?: SpinnerSize;
  readonly className?: string;
}

/**
 * OKLCH-themed SVG loading spinner with configurable size.
 *
 * Optimises `will-change` by removing it after the first animation cycle.
 */
export function Spinner({ size = "md", className }: SpinnerProps): React.ReactElement {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handler = () => {
      el.style.willChange = "auto";
    };

    el.style.willChange = "transform";
    el.addEventListener("animationiteration", handler, { once: true });

    return () => {
      el.removeEventListener("animationiteration", handler);
    };
  }, []);

  const px = sizeMap[size];

  return (
    <output aria-label="Loading" style={{ display: "inline-flex", lineHeight: 0 }}>
      <svg
        ref={ref}
        width={px}
        height={px}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
        style={{
          animation: "spinner-rotate 0.8s linear infinite",
          willChange: "transform",
        }}
      >
        <circle
          cx={12}
          cy={12}
          r={10}
          stroke="oklch(0.78 0.18 205 / 0.25)"
          strokeWidth={2.5}
          fill="none"
        />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="oklch(0.78 0.18 205)"
          strokeWidth={2.5}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </output>
  );
}
