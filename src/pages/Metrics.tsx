// ── Metrics ─────────────────────────────────────────
// Performance analytics: the same live tiles and charts as the Dashboard
// plus the AI metrics chart (queue depth, active streams, request and
// token rates).

import { PageHeader } from "#components/layout/PageHeader";
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
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title="Metrics" />
      <div style={metricsPageStyle}>
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
    </div>
  );
}
