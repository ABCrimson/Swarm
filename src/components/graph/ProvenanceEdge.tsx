import type { Edge, EdgeProps } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { ProvenanceEdgeKind } from "#store/provenance";

/** Every kind `ProvenanceEdge` can render — the four measured kinds plus `"manual"`, the user-drawn annotation kind kept visually distinct from measured facts (see `WorkerGraph`'s `onConnect`). */
export type GraphEdgeKind = ProvenanceEdgeKind | "manual";

/** Data payload every `ProvenanceEdge` instance reads from xyflow's `edge.data`. */
interface ProvenanceEdgeData extends Record<string, unknown> {
  readonly kind: GraphEdgeKind;
  /** Repeat-occurrence count for a measured edge (collapsed same-kind A->B occurrences); absent for a manual edge. */
  readonly count?: number;
  /** Seq of the most recent event that produced this measured edge — the CausalityPanel walk's starting point. Absent for a manual edge (nothing was measured). */
  readonly lastSeq?: number;
}

/** The graph's one edge type. */
export type ProvenanceFlowEdge = Edge<ProvenanceEdgeData, "provenance">;

/** Stroke colour and dash pattern per kind — the single table the legend's swatches also draw from. */
export const KIND_STYLE: Readonly<
  Record<GraphEdgeKind, { readonly stroke: string; readonly dash?: string }>
> = {
  spawn: { stroke: "oklch(0.78 0.18 205 / 0.8)" },
  kill: { stroke: "oklch(0.72 0.20 10 / 0.8)", dash: "3 3" },
  command: { stroke: "oklch(0.75 0.19 145 / 0.8)", dash: "7 3" },
  message: { stroke: "oklch(0.80 0.15 85 / 0.8)", dash: "1.5 3" },
  manual: { stroke: "oklch(0.72 0.02 220 / 0.8)", dash: "8 4" },
};

/** Title Case display name per kind (legend rows, edge accessible names). */
export const KIND_LABEL: Readonly<Record<GraphEdgeKind, string>> = {
  spawn: "Spawn",
  kill: "Kill",
  command: "Command",
  message: "Message",
  manual: "Manual",
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
 * `#store/provenance`) — never fabricated. A fifth kind, `manual`, is the
 * user's own hand-drawn annotation (via `onConnect`); it renders in a
 * desaturated style so annotations can never be mistaken for measured
 * facts. Repeated same-kind occurrences between the same two workers
 * collapse into one edge with a `×N` label and a thickness ramp (see
 * {@link strokeWidthForCount}).
 *
 * Motion is cheap and opt-in: a measured edge pulses (dash flow + glow)
 * for a few cycles when it appears and on each new occurrence — the path
 * is keyed on `lastSeq`, restarting the CSS animation — then rests, and
 * only a selected edge keeps its glow. The animation lives in `graph.css`
 * under `prefers-reduced-motion: no-preference`.
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
}: EdgeProps<ProvenanceFlowEdge>): React.ReactElement {
  const kind = data?.kind ?? "manual";
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const kindStyle = KIND_STYLE[kind];
  const count = data?.count ?? 1;
  const stroke = selected ? SELECTED_STROKE : kindStyle.stroke;

  return (
    <>
      <BaseEdge
        key={data?.lastSeq}
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className="provenance-edge__path"
        data-measured={kind !== "manual"}
        data-selected={selected === true}
        style={
          {
            ...style,
            "--edge-stroke": stroke,
            "--edge-width": `${strokeWidthForCount(count)}px`,
            strokeDasharray: kindStyle.dash,
          } as CSSProperties
        }
      />
      {count > 1 && (
        <EdgeLabelRenderer>
          <div
            aria-hidden="true"
            className="provenance-edge__count"
            style={
              { left: labelX, top: labelY, "--edge-stroke": kindStyle.stroke } as CSSProperties
            }
          >
            ×{count}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
