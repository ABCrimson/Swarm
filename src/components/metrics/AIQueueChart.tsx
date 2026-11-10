// ── AIQueueChart ────────────────────────────────────
// Pending AI requests by priority as one stacked bar.
// Colours: critical = rose, high = amber, normal = plasma, low = neutral grey.

import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";
import { ChartPanel } from "#components/metrics/ChartPanel";
import { BAR_SEGMENT_STROKE, PRIORITY_COLOR } from "#lib/chart-theme";
import { useAiStore } from "#store/ai";
import type { AiQueueItem } from "#store/types";

type Priority = AiQueueItem["priority"];

/** Stacking order (bottom to top) with each priority's label and colour. */
const PRIORITIES: readonly {
  readonly key: Priority;
  readonly label: string;
  readonly color: string;
}[] = [
  { key: "critical", label: "Critical", color: PRIORITY_COLOR.critical },
  { key: "high", label: "High", color: PRIORITY_COLOR.high },
  { key: "normal", label: "Normal", color: PRIORITY_COLOR.normal },
  { key: "low", label: "Low", color: PRIORITY_COLOR.low },
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
  const counts = pendingByPriority(queue);
  const pending = counts.critical + counts.high + counts.normal + counts.low;
  const data = [{ name: "Queue", ...counts }];

  return (
    <ChartPanel
      title="AI Queue By Priority"
      empty={pending === 0 ? "No Pending Requests" : undefined}
    >
      <BarChart
        responsive
        width="100%"
        height="100%"
        data={data}
        margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        title="Pending AI Requests By Priority"
      >
        <CartesianGrid />
        <XAxis dataKey="name" />
        <YAxis allowDecimals={false} />
        <Tooltip />
        <Legend itemSorter={null} />
        {PRIORITIES.map(({ key, label, color }) => (
          <Bar
            key={key}
            dataKey={key}
            name={label}
            stackId="queue"
            fill={color}
            stroke={BAR_SEGMENT_STROKE}
            strokeWidth={1}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartPanel>
  );
}
