// ── AIQueueChart ────────────────────────────────────
// Pending AI requests by priority as one stacked bar.
// Colours: critical = rose, high = amber, normal = plasma, low = neutral grey.

import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import { CHART_FILL_STYLE, ChartPanel } from "#components/metrics/ChartPanel";
import { useAiStore } from "#store/ai";
import type { AiQueueItem } from "#store/types";

type Priority = AiQueueItem["priority"];

/** Stacking order (bottom to top) with each priority's label and colour. */
const PRIORITIES: readonly {
  readonly key: Priority;
  readonly label: string;
  readonly color: string;
}[] = [
  { key: "critical", label: "Critical", color: "oklch(0.68 0.22 15)" },
  { key: "high", label: "High", color: "oklch(0.78 0.18 70)" },
  { key: "normal", label: "Normal", color: "oklch(0.72 0.18 205)" },
  { key: "low", label: "Low", color: "oklch(0.6 0.03 220)" },
];

/** Counts pending queue items per priority (every priority present, zero when none). */
export function pendingByPriority(queue: readonly AiQueueItem[]): Record<Priority, number> {
  const counts: Record<Priority, number> = { critical: 0, high: 0, normal: 0, low: 0 };
  for (const item of queue) {
    if (item.status === "pending") counts[item.priority] += 1;
  }
  return counts;
}

/** Stacked bar of pending AI requests per priority level. */
export function AIQueueChart(): React.ReactElement {
  const queue = useAiStore((s) => s.queue);
  const data = [{ name: "Queue", ...pendingByPriority(queue) }];

  return (
    <ChartPanel title="AI Queue By Priority">
      <BarChart
        responsive
        style={CHART_FILL_STYLE}
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        title="Pending AI Requests By Priority"
      >
        <CartesianGrid />
        <XAxis dataKey="name" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Legend />
        {PRIORITIES.map(({ key, label, color }) => (
          <Bar
            key={key}
            dataKey={key}
            name={label}
            stackId="queue"
            fill={color}
            stroke="oklch(0.08 0.02 220)"
            strokeWidth={1}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartPanel>
  );
}
