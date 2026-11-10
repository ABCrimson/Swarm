// ── Dashboard ───────────────────────────────────────
// Landing page: the live stat tiles plus the system and AI charts, fed by
// the `system_metrics` envelopes the backend emits every 500ms.

import { PageHeader } from "#components/layout/PageHeader";
import { AIQueueChart } from "#components/metrics/AIQueueChart";
import { CPUChart } from "#components/metrics/CPUChart";
import { MemoryChart } from "#components/metrics/MemoryChart";
import { MetricsChart } from "#components/metrics/MetricsChart";
import {
  ChartGrid,
  METRICS_PAGE_CLASS,
  MetricCards,
  MetricsSection,
} from "#components/metrics/MetricsOverview";
import { ThroughputChart } from "#components/metrics/ThroughputChart";

/**
 * Dashboard page with real-time metric cards and system/AI performance
 * charts. The Metrics page shares the same tiles (see `MetricCards`) and
 * adds the AI metrics chart.
 */
export function Dashboard(): React.ReactElement {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader title="Dashboard" />
      <div className={METRICS_PAGE_CLASS}>
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
    </div>
  );
}
