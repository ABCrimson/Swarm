// ── WorkerCard ──────────────────────────────────────
// Per-worker stats: uptime, messages sent, tool calls, error count.
// Sparklines using Recharts (small inline LineChart, no axis).
// OKLCH colored by worker state.

import type { CSSProperties } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { glassPanelStyle } from "#lib/chart-theme";
import type { WorkerState } from "#store/types";

interface WorkerCardProps {
  readonly id: string;
  readonly name: string;
  readonly state: WorkerState;
  readonly startedAt: string;
  readonly messagesSent?: number;
  readonly toolCalls?: number;
  readonly errorCount?: number;
  /** Recent activity data for sparkline. */
  readonly sparklineData?: ReadonlyArray<{ readonly value: number }>;
}

const STATE_COLOR: Record<WorkerState, string> = {
  idle: "oklch(0.55 0.04 220)",
  running: "oklch(0.78 0.18 140)",
  paused: "oklch(0.78 0.18 70)",
  error: "oklch(0.68 0.22 15)",
};

const cardStyle: CSSProperties = {
  ...glassPanelStyle,
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  cursor: "pointer",
  transition: "border-color 0.15s ease",
};

const labelStyle: CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: 10,
  color: "oklch(0.58 0.04 220)",
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};

const valueStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "oklch(0.78 0.04 220)",
};

function formatUptime(startedAt: string): string {
  const diff = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(diff / 60_000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

/**
 * Per-worker stats card with sparkline, uptime, message count, tool calls,
 * and error count. Colour-coded by worker lifecycle state via OKLCH.
 */
export function WorkerCard({
  id,
  name,
  state,
  startedAt,
  messagesSent = 0,
  toolCalls = 0,
  errorCount = 0,
  sparklineData = [],
}: WorkerCardProps): React.ReactElement {
  const stateColor = STATE_COLOR[state];

  const dotStyle: CSSProperties = {
    display: "inline-block",
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: stateColor,
    marginRight: 8,
  };

  return (
    <div
      style={cardStyle}
      data-worker-id={id}
      tabIndex={0}
      role="button"
      aria-label={`Worker ${name}, status: ${state}`}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "oklch(0.35 0.06 220)";
        e.currentTarget.style.background = "oklch(0.10 0.03 220 / 0.8)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "oklch(0.22 0.04 220)";
        e.currentTarget.style.background = "oklch(0.08 0.02 220 / 0.7)";
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center">
          <span style={dotStyle} aria-hidden="true" />
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 13,
              fontWeight: 600,
              color: "oklch(0.85 0.04 220)",
            }}
          >
            {name}
          </span>
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: stateColor,
            textTransform: "uppercase" as const,
          }}
        >
          {state}
        </span>
      </div>

      {/* Sparkline */}
      {sparklineData.length > 1 && (
        <div style={{ width: "100%", height: 24 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparklineData}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={stateColor}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
        <div>
          <div style={labelStyle}>Uptime</div>
          <div style={valueStyle}>{formatUptime(startedAt)}</div>
        </div>
        <div>
          <div style={labelStyle}>Messages</div>
          <div style={valueStyle}>{messagesSent}</div>
        </div>
        <div>
          <div style={labelStyle}>Tools</div>
          <div style={valueStyle}>{toolCalls}</div>
        </div>
        <div>
          <div style={labelStyle}>Errors</div>
          <div
            style={{
              ...valueStyle,
              color: errorCount > 0 ? "oklch(0.68 0.22 15)" : valueStyle.color,
            }}
          >
            {errorCount}
          </div>
        </div>
      </div>
    </div>
  );
}
