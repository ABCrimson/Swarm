import type { EdgeProps } from "@xyflow/react";
import { BaseEdge, getBezierPath } from "@xyflow/react";

/**
 * Animated bezier edge for the Workers topology graph.
 *
 * Labeled "Spawn Order" in the graph's legend — these edges connect
 * workers in the order they were added to the store (see
 * `buildGraphData` in `WorkerGraph.tsx`), not a real dependency
 * relationship (the `Worker` schema has no dependency/parent field).
 * Renders a dashed stroke with animated flow and OKLCH glow drop-shadow.
 */
export function SpawnOrderEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps): React.ReactElement {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        ...style,
        stroke: "oklch(0.78 0.18 205 / 0.6)",
        strokeWidth: 2,
        strokeDasharray: "8 4",
        animation: "dash-flow 1.2s linear infinite",
        filter: "drop-shadow(0 0 4px oklch(0.78 0.18 205 / 0.3))",
      }}
    />
  );
}
