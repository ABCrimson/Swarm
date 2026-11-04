// ── ChartPanel ──────────────────────────────────────
// The glass panel every metrics chart sits in: a title row (with an
// optional right-hand caption) above a body that takes the remaining
// height. The body installs the shared Recharts theme, and the chart
// inside sizes itself from it with Recharts 3's `responsive` prop — no
// ResponsiveContainer wrapper and no guessed percentage heights.
// With fewer than two samples the body shows a waiting line with a pulsing
// dot (a live state), and a snapshot chart with nothing to plot shows its
// `empty` line with no pulse (a resting state), never empty axes.

import type { CSSProperties } from "react";
import { RechartsThemeProvider } from "recharts";
import { CHART_THEME } from "#lib/chart-theme";

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  height: "100%",
  minHeight: 200,
  padding: 12,
  background: "oklch(from var(--color-surface-0) l c h / 0.7)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-lg)",
  backdropFilter: "blur(12px) saturate(1.5)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--color-fg)",
};

const captionStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: 11,
  fontWeight: 400,
  color: "var(--color-fg-dim)",
};

/** Style for the Recharts chart element itself: fill the panel body. */
export const CHART_FILL_STYLE: CSSProperties = { width: "100%", height: "100%" };

/**
 * Titled chart panel. `children` is one Recharts chart rendered with
 * `responsive` and {@link CHART_FILL_STYLE}.
 */
export function ChartPanel({
  title,
  caption,
  span,
  sampleCount,
  empty,
  children,
}: {
  readonly title: string;
  /** Short, Title Case note on the right of the title row (e.g. the sample window). */
  readonly caption?: string;
  /** "full" spans every column of the ChartGrid. */
  readonly span?: "full";
  /** Samples behind the chart. Under 2 the body says so instead of drawing empty axes; omit it for a snapshot chart. */
  readonly sampleCount?: number;
  /** A snapshot chart with nothing to plot: the body shows this line instead of empty axes. */
  readonly empty?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <figure
      style={span === "full" ? { ...panelStyle, gridColumn: "1 / -1" } : panelStyle}
      className="m-0"
    >
      <figcaption style={headerStyle}>
        <span>{title}</span>
        {caption && <span style={captionStyle}>{caption}</span>}
      </figcaption>
      <div style={{ flex: 1, minHeight: 0 }}>
        {(sampleCount !== undefined && sampleCount < 2) || empty !== undefined ? (
          <p className="m-0 flex h-full items-center justify-center gap-2 text-fg-dim text-md">
            {empty === undefined && (
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-plasma motion-safe:animate-[tool-pulse_2s_ease-in-out_infinite]"
              />
            )}
            {empty ?? "Waiting For Samples"}
          </p>
        ) : (
          <RechartsThemeProvider value={CHART_THEME}>{children}</RechartsThemeProvider>
        )}
      </div>
    </figure>
  );
}
