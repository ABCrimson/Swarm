// ── ChartPanel ──────────────────────────────────────
// The glass panel every metrics chart sits in: a title row (with an
// optional right-hand caption) above a body that takes the remaining
// height. The body installs the shared Recharts theme, and the chart
// inside sizes itself from it with Recharts 3's `responsive` prop — no
// ResponsiveContainer wrapper and no guessed percentage heights.

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
  background: "oklch(0.08 0.02 220 / 0.7)",
  border: "1px solid oklch(0.22 0.04 220)",
  borderRadius: 8,
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
  color: "oklch(0.85 0.04 220)",
};

const captionStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
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
  children,
}: {
  readonly title: string;
  /** Short, Title Case note on the right of the title row (e.g. the sample window). */
  readonly caption?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <figure style={panelStyle} className="m-0">
      <figcaption style={headerStyle}>
        <span>{title}</span>
        {caption && <span style={captionStyle}>{caption}</span>}
      </figcaption>
      <div style={{ flex: 1, minHeight: 0 }}>
        <RechartsThemeProvider value={CHART_THEME}>{children}</RechartsThemeProvider>
      </div>
    </figure>
  );
}
