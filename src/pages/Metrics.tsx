// ── Metrics ─────────────────────────────────────────
// Performance analytics: the same live tiles and charts as the Dashboard
// plus the AI metrics chart (queue depth, active streams, request and
// token rates).

import { AIMetricsChart } from "#components/metrics/AIMetricsChart";
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
 * Metrics page: summary tiles (severity banded by the user's alert
 * thresholds) and the full system/AI chart grid.
 */
export function Metrics(): React.ReactElement {
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
          Metrics
        </h1>
        <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "oklch(0.55 0.04 220)" }}>
          Performance Analytics And Resource Usage
        </p>
      </header>

      <MetricsSection title="Current">
        <MetricCards />
      </MetricsSection>

      <MetricsSection title="System">
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
          <AIMetricsChart />
        </ChartGrid>
      </MetricsSection>
    </div>
  );
}
