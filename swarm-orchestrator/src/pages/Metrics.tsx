import type { CSSProperties } from "react";
import { AIMetricsChart } from "#components/metrics/AIMetricsChart";
import { AIQueueChart } from "#components/metrics/AIQueueChart";
import { CPUChart } from "#components/metrics/CPUChart";
import { MemoryChart } from "#components/metrics/MemoryChart";
import { MetricCard } from "#components/metrics/MetricCard";
import { MetricsChart } from "#components/metrics/MetricsChart";
import { ThroughputChart } from "#components/metrics/ThroughputChart";
import { useSystemStore } from "#store/system";

type Severity = "good" | "warning" | "critical";

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

const chartGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
  gap: 16,
};

const cardGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 12,
};

function cpuSeverity(v: number): Severity {
  if (v > 80) return "critical";
  if (v > 60) return "warning";
  return "good";
}

function memSeverity(mb: number): Severity {
  const pct = (mb / 16_384) * 100;
  if (pct > 90) return "critical";
  if (pct > 70) return "warning";
  return "good";
}

/**
 * Metrics page with summary cards and system/AI performance chart grids.
 *
 * Displays CPU, memory, worker count, AI requests/sec, and tokens/sec
 * with severity colour coding.
 */
export function Metrics(): React.ReactElement {
  const metrics = useSystemStore((s) => s.metrics);

  return (
    <div style={pageStyle}>
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
          Metrics
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "oklch(0.55 0.04 220)",
          }}
        >
          Performance analytics and resource usage
        </p>
      </div>

      {/* Summary cards */}
      <section>
        <div style={sectionHeaderStyle}>Current</div>
        <div style={cardGridStyle}>
          <MetricCard
            label="CPU"
            value={`${(metrics.cpuPercent ?? 0).toFixed(1)}%`}
            severity={cpuSeverity(metrics.cpuPercent ?? 0)}
          />
          <MetricCard
            label="Memory"
            value={`${(metrics.memoryMb ?? 0).toFixed(0)} MB`}
            severity={memSeverity(metrics.memoryMb ?? 0)}
          />
          <MetricCard label="Workers" value={`${metrics.workerCount ?? 0}`} />
          <MetricCard label="AI Req/s" value={`${(metrics.aiReqPerSec ?? 0).toFixed(1)}`} />
          <MetricCard label="Tokens/s" value={`${(metrics.tokensPerSec ?? 0).toFixed(0)}`} />
        </div>
      </section>

      {/* System charts */}
      <section>
        <div style={sectionHeaderStyle}>System</div>
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
          <div style={{ height: 280 }}>
            <AIMetricsChart />
          </div>
        </div>
      </section>
    </div>
  );
}
