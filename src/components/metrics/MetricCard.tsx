// ── MetricCard ──────────────────────────────────────
// One stat tile: label, current value and, only when the caller measured
// one, a trend arrow. The value is fg-bright when good and coloured only
// when a threshold speaks (amber = warning, rose = critical); the tiles
// share one divided glass strip, and a warning or critical value also
// shows its name, so severity never rests on colour alone.
//
// Semantics: a tile is one term/description pair of the enclosing
// `<dl>` (see `MetricCardList`), so assistive tech reads "CPU Usage,
// 42.0%" as a labelled value rather than a form group.

import type { Severity } from "#lib/severity";

/** Direction of a measured change over the recent samples. */
export type Trend = "up" | "down" | "stable";

interface MetricCardProps {
  readonly label: string;
  readonly value: string;
  readonly severity?: Severity | undefined;
  /** Omit when there is no real series behind the value — no arrow is invented. */
  readonly trend?: Trend | undefined;
}

/** Value text colour per severity: fg-bright at rest, the amber and rose tokens (as on the warning/danger pills) when a threshold speaks. */
export const SEVERITY_TEXT: Readonly<Record<Severity, string>> = {
  good: "text-fg-bright",
  warning: "text-amber",
  critical: "text-rose",
};

/** Visible name for a non-good severity, so the state never rests on colour alone. */
const SEVERITY_LABEL: Readonly<Record<Exclude<Severity, "good">, string>> = {
  warning: "Warning",
  critical: "Critical",
};

const TREND: Readonly<Record<Trend, { readonly symbol: string; readonly label: string }>> = {
  up: { symbol: "↑", label: "Trending Up" },
  down: { symbol: "↓", label: "Trending Down" },
  stable: { symbol: "→", label: "Stable" },
};

const CARD_CLASS = "flex min-w-[140px] flex-col gap-1 px-4 py-3";
const LABEL_CLASS = "font-body text-[12px] font-medium text-fg-muted";

/**
 * Compact metric tile with label, severity-coloured value and an optional
 * trend arrow. Must be rendered inside a {@link MetricCardList}.
 */
export function MetricCard({
  label,
  value,
  severity = "good",
  trend,
}: MetricCardProps): React.ReactElement {
  const accent = SEVERITY_TEXT[severity];

  return (
    <div className={CARD_CLASS} data-severity={severity}>
      <dt className={LABEL_CLASS}>{label}</dt>
      <dd className="m-0 flex items-end gap-2">
        <span className={`font-mono text-[22px] leading-none font-bold ${accent}`}>{value}</span>
        {severity !== "good" && (
          <span className={`font-body text-[11px] leading-[1.4] font-semibold ${accent}`}>
            {SEVERITY_LABEL[severity]}
          </span>
        )}
        {trend && (
          <span className={`font-mono text-[14px] leading-[1.4] opacity-70 ${accent}`}>
            <span aria-hidden="true">{TREND[trend].symbol}</span>
            <span className="sr-only">{TREND[trend].label}</span>
          </span>
        )}
      </dd>
    </div>
  );
}

/** The `<dl>` grid that {@link MetricCard} tiles live in. */
export function MetricCardList({
  children,
}: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] overflow-hidden rounded-lg border border-border bg-surface-0/70 backdrop-blur-[12px] backdrop-saturate-150 *:shadow-[-1px_-1px_0_var(--color-border)]">
      {children}
    </dl>
  );
}
