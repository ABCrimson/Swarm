import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { Badge, stateLabels } from "#components/ui/Badge";
import { Pill } from "#components/ui/Pill";
import { withAlpha, workerColor } from "#lib/theme";
import { useProvenanceStore } from "#store/provenance";
import { useWorkerStore } from "#store/workers";

/** Node data: which worker, and its colour slot. Everything live is read from the stores. */
interface WorkerNodeData extends Record<string, unknown> {
  readonly workerId: string;
  readonly index: number;
}

/** The graph's one node type. */
export type WorkerFlowNode = Node<WorkerNodeData, "worker">;

const handleStyle = (color: string): CSSProperties => ({
  background: color,
  border: "none",
  width: 8,
  height: 8,
});

/**
 * One worker in the Workers topology graph (measured causality): name,
 * state badge, PID and — once it has written any — a "Wrote N Files"
 * badge counted from `file_written` events.
 *
 * The node subscribes to its own worker's name/state/PID and file count
 * with primitive selectors, so a PTY output chunk (which replaces the
 * worker object) re-renders nothing here, and the graph itself never
 * re-renders for a state change. Keyboard focus and the accessible name
 * live on xyflow's node wrapper (see `WorkerGraph`'s `ariaLabel`); this
 * content is presentational. Glow and hover scale are CSS (`graph.css`),
 * off under reduced motion.
 */
export function WorkerNode({ data }: NodeProps<WorkerFlowNode>): React.ReactElement | null {
  const { workerId, index } = data;
  const name = useWorkerStore((s) => s.workers.get(workerId)?.name);
  const state = useWorkerStore((s) => s.workers.get(workerId)?.state);
  const pid = useWorkerStore((s) => s.workers.get(workerId)?.pid);
  const fileWriteCount = useProvenanceStore((s) => s.fileWriteCounts.get(workerId) ?? 0);

  // The worker left the store; the graph drops this node on its next render.
  if (state === undefined) return null;

  const color = workerColor(index);

  return (
    <div
      className="worker-node"
      data-state={state}
      style={
        {
          "--node-border": withAlpha(color, 0.5),
          "--node-glow": withAlpha(color, 0.3),
          "--node-glow-far": withAlpha(color, 0.15),
        } as CSSProperties
      }
    >
      <Handle type="target" position={Position.Top} style={handleStyle(color)} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "0.8125rem",
            fontWeight: 600,
            color: "oklch(0.95 0.02 220)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 140,
          }}
        >
          {name ?? workerId.slice(0, 8)}
        </span>
        <Badge state={state}>{stateLabels[state]}</Badge>
      </div>

      {pid != null && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6875rem",
            color: "oklch(0.55 0.04 220)",
          }}
        >
          PID {pid}
        </span>
      )}

      {fileWriteCount > 0 && (
        <Pill tone="info" size="sm" style={{ alignSelf: "flex-start" }}>
          Wrote {fileWriteCount} {fileWriteCount === 1 ? "File" : "Files"}
        </Pill>
      )}

      {state === "running" && <div aria-hidden="true" className="worker-node__glow" />}

      <Handle type="source" position={Position.Bottom} style={handleStyle(color)} />
    </div>
  );
}
