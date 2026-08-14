import type { EdgeProps } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { ProvenanceEdgeKind } from "#store/provenance";

/** Every kind `ProvenanceEdge` can render — the four measured kinds plus `"manual"`, the user-drawn annotation kind kept visually distinct from measured facts (see `WorkerGraph.tsx`'s `onConnect`). */
export type GraphEdgeKind = ProvenanceEdgeKind | "manual";

/** Data payload every `ProvenanceEdge` instance reads from XYFlow's `edge.data`. */
export interface ProvenanceEdgeData extends Record<string, unknown> {
  readonly kind: GraphEdgeKind;
  /** Repeat-occurrence count for a measured edge (collapsed same-kind A->B occurrences); absent/1 for a manual edge. */
  readonly count?: number;
  /** Seq of the most recent event that produced this measured edge — the CausalityPanel walk's starting point. Absent for a manual edge (nothing was measured). */
  readonly lastSeq?: number;
}

const KIND_STYLE: Record<GraphEdgeKind, { readonly stroke: string; readonly dash?: string }> = {
  spawn: { stroke: "oklch(0.78 0.18 205 / 0.8)" },
  kill: { stroke: "oklch(0.72 0.20 10 / 0.8)", dash: "3 3" },
  command: { stroke: "oklch(0.75 0.19 145 / 0.8)", dash: "7 3" },
  message: { stroke: "oklch(0.80 0.15 85 / 0.8)", dash: "1.5 3" },
  manual: { stroke: "oklch(0.60 0.02 220 / 0.6)", dash: "8 4" },
};

const SELECTED_STROKE = "oklch(0.85 0.20 205)";
const BASE_STROKE_WIDTH = 2;
const MAX_STROKE_WIDTH = 6;

/**
 * Maps a repeat count to a stroke width — 2px at count 1, ramping by
 * log2 so a heavily-repeated edge reads as visibly "thicker" without
 * growing unboundedly thick for a chatty pair of workers.
 */
function strokeWidthForCount(count: number): number {
  if (count <= 1) return BASE_STROKE_WIDTH;
  return Math.min(BASE_STROKE_WIDTH + Math.log2(count) * 1.4, MAX_STROKE_WIDTH);
}

/**
 * Edge renderer for the Workers topology graph, parameterized by kind.
 *
 * Four kinds (`spawn`, `kill`, `command`, `message`) render MEASURED
 * causal edges derived from stamped `swarm://events` envelopes (see
 * `#store/provenance`) — never fabricated. A fifth kind, `manual`, is
 * the user's own hand-drawn annotation (via `onConnect`); it renders
 * with a visually distinct, desaturated style so annotations can never
 * be mistaken for measured facts. Repeated same-kind occurrences between
 * the same two workers collapse into one edge with a `×N` label and a
 * thickness ramp (see {@link strokeWidthForCount}).
 */
export function ProvenanceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
  data,
}: EdgeProps): React.ReactElement {
  const edgeData = (data as ProvenanceEdgeData | undefined) ?? { kind: "manual" };
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const kindStyle = KIND_STYLE[edgeData.kind] ?? KIND_STYLE.manual;
  const count = edgeData.count ?? 1;
  const stroke = selected ? SELECTED_STROKE : kindStyle.stroke;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke,
          strokeWidth: strokeWidthForCount(count),
          strokeDasharray: kindStyle.dash,
          animation: edgeData.kind !== "manual" ? "dash-flow 1.2s linear infinite" : undefined,
          filter: `drop-shadow(0 0 4px ${stroke})`,
        }}
      />
      {count > 1 && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "none",
              fontFamily: "var(--font-mono)",
              fontSize: "0.625rem",
              fontWeight: 600,
              color: "oklch(0.95 0.02 220)",
              background: "oklch(0.10 0.03 220 / 0.85)",
              border: `1px solid ${kindStyle.stroke}`,
              borderRadius: 4,
              padding: "1px 5px",
            }}
          >
            ×{count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
