// ── ChartPanel ──────────────────────────────────────
// The glass panel every metrics chart sits in: a title row (with an
// optional right-hand caption) above a body that takes the remaining
// height. The body installs the shared Recharts theme, and the chart
// inside sizes itself from it with Recharts 3's `responsive` prop — no
// ResponsiveContainer wrapper and no guessed percentage heights.
// With fewer than two samples the body shows a waiting line with a pulsing
// dot (a live state), and a snapshot chart with nothing to plot shows its
// `empty` line with no pulse (a resting state), never empty axes.

import { RechartsThemeProvider } from "recharts";
import { CHART_THEME } from "#lib/chart-theme";

const PANEL_CLASS =
  "m-0 flex h-full min-h-[200px] flex-col gap-2 rounded-lg border border-border bg-surface-0/70 p-3 backdrop-blur-[12px] backdrop-saturate-150";
const HEADER_CLASS =
  "m-0 flex items-baseline justify-between gap-2 font-display text-[14px] font-semibold text-fg";
const CAPTION_CLASS = "font-body text-[11px] font-normal text-fg-dim";

/**
 * Titled chart panel. `children` is one Recharts chart rendered with
 * `responsive`, `width="100%"` and `height="100%"` so it fills the panel body.
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
    <figure className={span === "full" ? `${PANEL_CLASS} col-[1/-1]` : PANEL_CLASS}>
      <figcaption className={HEADER_CLASS}>
        <span>{title}</span>
        {caption && <span className={CAPTION_CLASS}>{caption}</span>}
      </figcaption>
      <div className="min-h-0 flex-1">
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
