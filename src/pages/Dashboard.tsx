// ── Dashboard ───────────────────────────────────────
// Landing page: the live stat tiles plus the system and AI charts, fed by
// the `system_metrics` envelopes the backend emits every 500ms.

import { AIQueueChart } from "#components/metrics/AIQueueChart";
import { CPUChart } from "#components/metrics/CPUChart";
import { MemoryChart } from "#components/metrics/MemoryChart";
import { MetricsChart } from "#components/metrics/MetricsChart";
import {
  ChartGrid,
  MetricCards,
  MetricsSection,
  metricsPageStyle,
} from "#components/metrics/MetricsOverview";
import { ThroughputChart } from "#components/metrics/ThroughputChart";

/**
 * Dashboard page with real-time metric cards and system/AI performance
 * charts. The Metrics page shares the same tiles (see `MetricCards`) and
 * adds the AI metrics chart.
 */
export function Dashboard(): React.ReactElement {
  return (
    <div style={metricsPageStyle}>
      <header>
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
        <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "oklch(0.55 0.04 220)" }}>
          System Overview And Real-Time Metrics
        </p>
      </header>

      <MetricsSection title="Overview">
        <MetricCards />
      </MetricsSection>

      <MetricsSection title="System Performance">
        <ChartGrid>
          <MetricsChart />
          <CPUChart />
          <MemoryChart />
        </ChartGrid>
      </MetricsSection>

      <MetricsSection title="AI Performance">
        <ChartGrid>
          <ThroughputChart />
          <AIQueueChart />
        </ChartGrid>
      </MetricsSection>
    </div>
  );
}
