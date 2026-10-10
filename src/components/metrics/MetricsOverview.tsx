// ── Metrics Overview ────────────────────────────────
// The building blocks the Dashboard and Metrics pages share: the live
// stat tiles, a titled page section and the responsive chart grid. Both
// pages render the SAME tiles through `MetricCards`, so they can never
// disagree about a value, its severity or its trend.

import { useAtomValue } from "jotai";
import type { CSSProperties } from "react";
import { useId } from "react";
import type { Trend } from "#components/metrics/MetricCard";
import { MetricCard, MetricCardList } from "#components/metrics/MetricCard";
import { alertThresholdsAtom } from "#lib/alerts";
import { formatMb } from "#lib/chart-theme";
import { lastN } from "#lib/chart-window";
import { memPercent, memSeverity } from "#lib/memory";
import { severityFor } from "#lib/severity";
import { useSystemStore } from "#store/system";

/** Samples a trend looks back over, and the percentage-point move that counts as one. */
const TREND_SAMPLES = 4;
const TREND_THRESHOLD_POINTS = 3;

/**
 * Direction of `values` over its span, or `undefined` when there are too
 * few samples to say — the card then shows no arrow rather than a guess.
 */
export function trendOf(values: readonly number[]): Trend | undefined {
  const first = values.at(0);
  const last = values.at(-1);
  if (values.length < TREND_SAMPLES || first === undefined || last === undefined) return undefined;
  const delta = last - first;
  if (delta > TREND_THRESHOLD_POINTS) return "up";
  if (delta < -TREND_THRESHOLD_POINTS) return "down";
  return "stable";
}

/**
 * The four live stat tiles (no AI requests/s tile: the backend measures no
 * provider request rate, so it would only ever show 0.0). CPU and memory are banded by the user's own
 * alert thresholds (the same `>=` rule as the alert toasts) and carry a
 * trend measured over the last few samples; the counters have neither.
 */
export function MetricCards(): React.ReactElement {
  const metrics = useSystemStore((s) => s.metrics);
  const thresholds = useAtomValue(alertThresholdsAtom);
  const { cpuPercent, memoryMb, memoryTotalMb, workerCount, tokensPerSec } = metrics;

  const recent = lastN(metrics.history, TREND_SAMPLES);
  const cpuTrend = trendOf(recent.map((p) => p.cpu));
  const memoryPercents = recent.flatMap((p) => memPercent(p.memory, memoryTotalMb) ?? []);
  const memoryTrend = trendOf(memoryPercents);

  return (
    <MetricCardList>
      <MetricCard
        label="CPU Usage"
        value={`${cpuPercent.toFixed(1)}%`}
        severity={severityFor(cpuPercent, {
          warning: thresholds.cpuWarning,
          critical: thresholds.cpuCritical,
        })}
        trend={cpuTrend}
      />
      <MetricCard
        label="Memory"
        value={formatMb(memoryMb)}
        severity={memSeverity(memoryMb, memoryTotalMb, {
          warning: thresholds.memoryWarning,
          critical: thresholds.memoryCritical,
        })}
        trend={memoryTrend}
      />
      <MetricCard label="Workers" value={`${workerCount}`} />
      <MetricCard label="Tokens/s" value={tokensPerSec.toFixed(0)} />
    </MetricCardList>
  );
}

const sectionTitleStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: "0.04em",
  color: "oklch(0.75 0.06 220)",
  textTransform: "uppercase",
  margin: "0 0 4px",
};

/** A page section named by its own `<h2>`, so heading navigation reaches it. */
export function MetricsSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} style={sectionTitleStyle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

const chartGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))",
  gridAutoRows: 280,
  gap: 16,
};

/** Responsive grid of fixed-height chart panels. */
export function ChartGrid({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return <div style={chartGridStyle}>{children}</div>;
}

/** Scrollable page column shared by the metrics pages. */
export const metricsPageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 24,
  padding: "24px 28px 56px",
  overflowY: "auto",
  height: "100%",
};
