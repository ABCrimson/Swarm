import type { CSSProperties, ReactNode } from "react";

export type PillTone = "neutral" | "info" | "success" | "warning" | "danger";
export type PillSize = "sm" | "md";

type PillOwnProps = {
  /** Semantic color — distinct from decorative/categorical accent colors, which stay as an inline `style` override. */
  readonly tone?: PillTone;
  readonly size?: PillSize;
  /** A pill that ACTS renders a real `<button>` (hover/active/focus-visible). A pill that only LABELS renders a static `<span>`. */
  readonly interactive?: boolean;
  /** Caps the label width so overflowing (e.g. user-generated) text ellipsizes instead of stretching the pill. */
  readonly maxWidth?: number | string;
};

type PillProps = PillOwnProps & Omit<React.ComponentPropsWithoutRef<"button">, keyof PillOwnProps>;

/**
 * Consolidated pill/chip element — the single implementation for every
 * "small rounded label" in the app (worker state, tool badges, log
 * levels, capability chips, counters, command-palette hints, action
 * pills like Kill/Pause/Resume).
 *
 * Fixed padding/radius/height/font-size/letter-spacing per `size`, and a
 * fixed semantic color per `tone` (mapped to the house OKLCH tokens).
 * Decorative/categorical colors (e.g. per-tool-name accents) that aren't
 * one of the five semantic tones can still be applied via a `style`
 * override — inline styles win over the `.swarm-pill` class, so shape
 * stays consistent while color stays per-instance.
 *
 * `interactive` controls the rendered element and affordance: pills that
 * act (Kill, etc.) render as `<button>` with hover/active/focus-visible
 * states; pills that only label render as a static, non-interactive
 * `<span>`.
 */
export function Pill({
  tone = "neutral",
  size = "sm",
  interactive = false,
  maxWidth,
  children,
  className,
  style,
  type = "button",
  ...props
}: PillProps): React.ReactElement {
  const Component: React.ElementType = interactive ? "button" : "span";
  const labelStyle: CSSProperties | undefined = maxWidth != null ? { maxWidth } : undefined;

  return (
    <Component
      type={interactive ? type : undefined}
      className={`swarm-pill ${className ?? ""}`}
      data-tone={tone}
      data-size={size}
      data-interactive={interactive || undefined}
      style={style}
      {...props}
    >
      <span className="swarm-pill-label" style={labelStyle}>
        {children as ReactNode}
      </span>
    </Component>
  );
}
