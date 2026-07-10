// ── Dashboard ───────────────────────────────────────
// Full dashboard layout with grid of metric cards + charts.
// Real-time data from `system_metrics` envelopes on swarm://events at 500ms.
// Section headers in Syne Variable, metrics in JetBrains Mono.

import type { CSSProperties } from "react";
import { AIQueueChart } from "#components/metrics/AIQueueChart";
import { CPUChart } from "#components/metrics/CPUChart";
import { MemoryChart } from "#components/metrics/MemoryChart";
import { MetricCard } from "#components/metrics/MetricCard";
import { MetricsChart } from "#components/metrics/MetricsChart";
import { ThroughputChart } from "#components/metrics/ThroughputChart";
import { useSystemStore } from "#store/system";

type Severity = "good" | "warning" | "critical";
type Trend = "up" | "down" | "stable";

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 24,
  padding: "24px 28px 56px",
  overflowY: "auto",
  height: "100%",
};

const sectionHeaderStyle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: "0.04em",
  color: "oklch(0.75 0.06 220)",
  textTransform: "uppercase" as const,
  marginBottom: 4,
};

const cardGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 12,
};

const chartGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
  gap: 16,
};

function cpuSeverity(cpu: number): Severity {
  if (cpu > 80) return "critical";
  if (cpu > 60) return "warning";
  return "good";
}

function memSeverity(mb: number): Severity {
  // Assume 16GB total
  const pct = (mb / 16_384) * 100;
  if (pct > 90) return "critical";
  if (pct > 70) return "warning";
  return "good";
}

function computeTrend(history: Array<{ cpu: number }>, field: "cpu"): Trend {
  if (history.length < 4) return "stable";
  const recent = history.slice(-4);
  const first = recent[0][field];
  const last = recent[recent.length - 1][field];
  const delta = last - first;
  if (delta > 3) return "up";
  if (delta < -3) return "down";
  return "stable";
}

/**
 * Dashboard page with real-time metric cards and system/AI performance charts.
 *
 * Receives 500ms metric updates from the Rust backend and renders
 * CPU, memory, throughput, and queue visualisations.
 */
export function Dashboard(): React.ReactElement {
  const metrics = useSystemStore((s) => s.metrics);
  const history = metrics.history ?? [];

  const cpu = metrics.cpuPercent ?? 0;
  const mem = metrics.memoryMb ?? 0;
  const aiReq = metrics.aiReqPerSec ?? 0;
  const tokens = metrics.tokensPerSec ?? 0;
  const workers = metrics.workerCount ?? 0;

  const cpuTrend = computeTrend(history, "cpu");

  return (
    <div style={pageStyle}>
      {/* Page header */}
      <div>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "oklch(0.95 0.02 220)",
            marginBottom: 4,
          }}
        >
          Dashboard
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "oklch(0.55 0.04 220)",
          }}
        >
          System overview and real-time metrics
        </p>
      </div>

      {/* Metric cards */}
      <section>
        <div style={sectionHeaderStyle}>Overview</div>
        <div style={cardGridStyle}>
          <MetricCard
            label="CPU Usage"
            value={`${cpu.toFixed(1)}%`}
            severity={cpuSeverity(cpu)}
            trend={cpuTrend}
          />
          <MetricCard label="Memory" value={`${mem.toFixed(0)} MB`} severity={memSeverity(mem)} />
          <MetricCard label="Workers" value={`${workers}`} severity="good" />
          <MetricCard label="AI Req/s" value={`${aiReq.toFixed(1)}`} severity="good" />
          <MetricCard label="Tokens/s" value={`${tokens.toFixed(0)}`} severity="good" />
        </div>
      </section>

      {/* System charts */}
      <section>
        <div style={sectionHeaderStyle}>System Performance</div>
        <div style={chartGridStyle}>
          <div style={{ height: 280 }}>
            <MetricsChart />
          </div>
          <div style={{ height: 280 }}>
            <CPUChart />
          </div>
          <div style={{ height: 280 }}>
            <MemoryChart />
          </div>
        </div>
      </section>

      {/* AI charts */}
      <section>
        <div style={sectionHeaderStyle}>AI Performance</div>
        <div style={chartGridStyle}>
          <div style={{ height: 280 }}>
            <ThroughputChart />
          </div>
          <div style={{ height: 280 }}>
            <AIQueueChart />
          </div>
        </div>
      </section>
    </div>
  );
}
