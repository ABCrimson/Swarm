import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { Badge, stateLabels } from "#components/ui/Badge";
import { Pill } from "#components/ui/Pill";
import { escapeForDisplay } from "#lib/display-escape";
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

/** The handle's fill is the worker's colour, handed to the class as a custom property. */
const HANDLE_CLASS = "size-2 border-none bg-(--handle-color)";
const handleStyle = (color: string): CSSProperties =>
  ({ "--handle-color": color }) as CSSProperties;

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
      <Handle
        type="target"
        position={Position.Top}
        className={HANDLE_CLASS}
        style={handleStyle(color)}
      />

      <div className="flex items-center justify-between">
        <span className="max-w-[140px] truncate font-display text-[0.8125rem] font-semibold text-fg-bright">
          {escapeForDisplay(name ?? workerId.slice(0, 8))}
        </span>
        <Badge state={state}>{stateLabels[state]}</Badge>
      </div>

      {pid != null && <span className="font-mono text-[0.6875rem] text-fg-dim">PID {pid}</span>}

      {fileWriteCount > 0 && (
        <Pill tone="info" size="sm" className="self-start">
          Wrote {fileWriteCount} {fileWriteCount === 1 ? "File" : "Files"}
        </Pill>
      )}

      {state === "running" && <div aria-hidden="true" className="worker-node__glow" />}

      <Handle
        type="source"
        position={Position.Bottom}
        className={HANDLE_CLASS}
        style={handleStyle(color)}
      />
    </div>
  );
}
