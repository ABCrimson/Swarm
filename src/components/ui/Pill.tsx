import type { CSSProperties } from "react";

export type PillTone = "neutral" | "info" | "success" | "warning" | "danger";
type PillSize = "sm" | "md";

interface PillOwnProps {
  /** Semantic color — distinct from decorative/categorical accent colors, which are applied as utility classes in `className`. */
  readonly tone?: PillTone;
  readonly size?: PillSize;
  /** Caps the label width so overflowing (e.g. user-generated) text ellipsizes instead of stretching the pill. */
  readonly maxWidth?: number | string;
}

/** A pill that only labels: a static `<span>`, which takes no click handler. */
type StaticPillProps = PillOwnProps & { readonly interactive?: false } & Omit<
    React.ComponentPropsWithRef<"span">,
    keyof PillOwnProps | "onClick"
  >;

/** A pill that acts: a real `<button>` with hover, active and focus-visible states. */
type InteractivePillProps = PillOwnProps & { readonly interactive: true } & Omit<
    React.ComponentPropsWithRef<"button">,
    keyof PillOwnProps
  >;

type PillProps = StaticPillProps | InteractivePillProps;

/**
 * Consolidated pill/chip element — the single implementation for every
 * "small rounded label" in the app (worker state, tool badges, log
 * levels, capability chips, counters, action pills like
 * Kill/Pause/Resume).
 *
 * Fixed padding/radius/height/font-size/letter-spacing per `size`, and a
 * fixed semantic color per `tone` (`.swarm-pill` in components.css).
 * Decorative/categorical colors (e.g. per-tool-name accents) that aren't
 * one of the five semantic tones can still be applied through `className`
 * utilities — the `utilities` layer wins over the `.swarm-pill` rules in the
 * `components` layer (an inline `style` wins too) — so shape stays
 * consistent while color stays per-instance.
 *
 * `interactive` picks the element: pills that act render a `<button>`
 * (and are the only ones the types let take `onClick`); pills that only
 * label render a static `<span>`. Either forwards `ref`.
 */
export function Pill(props: PillProps): React.ReactElement {
  const { tone = "neutral", size = "sm", maxWidth, children, className, ...rest } = props;
  const label = (
    <span
      className={
        maxWidth != null ? "swarm-pill-label max-w-(--pill-max-width)" : "swarm-pill-label"
      }
      style={
        maxWidth != null
          ? ({
              "--pill-max-width": typeof maxWidth === "number" ? `${maxWidth}px` : maxWidth,
            } as CSSProperties)
          : undefined
      }
    >
      {children}
    </span>
  );
  const pillClass = `swarm-pill ${className ?? ""}`;

  if (rest.interactive) {
    const { interactive: _, type = "button", ...buttonProps } = rest;
    return (
      <button
        type={type}
        className={pillClass}
        data-tone={tone}
        data-size={size}
        data-interactive
        {...buttonProps}
      >
        {label}
      </button>
    );
  }

  const { interactive: _, ...spanProps } = rest;
  return (
    <span className={pillClass} data-tone={tone} data-size={size} {...spanProps}>
      {label}
    </span>
  );
}
