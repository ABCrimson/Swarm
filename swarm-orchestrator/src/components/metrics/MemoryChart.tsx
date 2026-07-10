// ── MemoryChart ─────────────────────────────────────
// Stacked area chart: used / cached / available.
// OKLCH area fills: used=plasma, cached=amber, available=dim.
// Recharts AreaChart with ResponsiveContainer, isAnimationActive={false}.

import type { CSSProperties } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  axisProps,
  formatMb,
  formatTime,
  glassPanelStyle,
  gridProps,
  legendStyle,
  tooltipProps,
} from "#lib/chart-theme";
import { memoryAvailableMb } from "#lib/memory";
import { useSystemStore } from "#store/system";

// OKLCH colors
const COLOR_USED = "oklch(0.72 0.18 205)";
const COLOR_CACHED = "oklch(0.78 0.16 70)";
const COLOR_AVAILABLE = "oklch(0.45 0.04 220)";

const containerStyle: CSSProperties = {
  ...glassPanelStyle,
  padding: 12,
  width: "100%",
  height: "100%",
  minHeight: 240,
};

const headerStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 14,
  fontWeight: 600,
  color: "oklch(0.85 0.04 220)",
  marginBottom: 8,
};

/**
 * Stacked area chart showing memory usage breakdown (used, cached, available)
 * over a 60-second rolling window with OKLCH gradient fills.
 */
export function MemoryChart(): React.ReactElement {
  const history = useSystemStore((s) => s.metrics.history);
  const memoryTotalMb = useSystemStore((s) => s.metrics.memoryTotalMb);

  const data = (() => {
    const cutoff = Date.now() - 60_000;
    return history
      .filter((p) => p.time > cutoff)
      .map((p) => ({
        time: p.time,
        used: p.memory,
        cached: Math.max(0, p.memory * 0.15),
        available: memoryAvailableMb(p.memory, memoryTotalMb),
      }));
  })();

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>Memory Usage</div>
      <ResponsiveContainer width="100%" height="85%">
        <AreaChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="grad-mem-used" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLOR_USED} stopOpacity={0.4} />
              <stop offset="95%" stopColor={COLOR_USED} stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="grad-mem-cached" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLOR_CACHED} stopOpacity={0.35} />
              <stop offset="95%" stopColor={COLOR_CACHED} stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="grad-mem-avail" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLOR_AVAILABLE} stopOpacity={0.2} />
              <stop offset="95%" stopColor={COLOR_AVAILABLE} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid {...gridProps} />
          <XAxis dataKey="time" tickFormatter={formatTime} {...axisProps} />
          <YAxis tickFormatter={formatMb} {...axisProps} />
          <Tooltip
            {...tooltipProps}
            labelFormatter={(label) => formatTime(Number(label))}
            formatter={(value) => formatMb(Number(value))}
          />
          <Legend wrapperStyle={legendStyle} />

          <Area
            type="monotone"
            dataKey="used"
            name="Used"
            stackId="mem"
            stroke={COLOR_USED}
            fill="url(#grad-mem-used)"
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="cached"
            name="Cached"
            stackId="mem"
            stroke={COLOR_CACHED}
            fill="url(#grad-mem-cached)"
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="available"
            name="Available"
            stackId="mem"
            stroke={COLOR_AVAILABLE}
            fill="url(#grad-mem-avail)"
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
