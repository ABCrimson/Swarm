import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { motion } from "motion/react";
import { Badge, stateLabels } from "#components/ui/Badge";
import { withAlpha, workerColor } from "#lib/theme";
import type { WorkerState } from "#store/types";

export interface WorkerNodeData {
  readonly label: string;
  readonly state: WorkerState;
  readonly index: number;
  readonly pid?: number;
}

type WorkerNodeType = Node<WorkerNodeData & Record<string, unknown>, "worker">;

/**
 * Custom React Flow node representing a SWARM worker in the dependency graph.
 *
 * Renders a glass-morphism card with OKLCH glow when running,
 * state badge, PID, and connection handles.
 */
export function WorkerNode({ data }: NodeProps<WorkerNodeType>): React.ReactElement {
  const { label, state, index, pid } = data;
  const color = workerColor(index);
  const glowColor = withAlpha(color, 0.3);
  const borderColor = withAlpha(color, 0.5);
  const isRunning = state === "running";

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      // Trigger the same activation path as a mouse click — XYFlow binds
      // its onNodeClick handler to a click listener on the node wrapper,
      // so a synthetic click bubbles up through it.
      event.currentTarget.click();
    }
  };

  return (
    <motion.div
      data-state={state}
      tabIndex={0}
      role="button"
      aria-label={`Worker ${label}, status: ${stateLabels[state]}${pid != null ? `, PID ${pid}` : ""}`}
      onKeyDown={handleKeyDown}
      whileHover={{ scale: 1.02 }}
      whileFocus={{ scale: 1.02 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      style={{
        position: "relative",
        width: 220,
        minHeight: 100,
        background: "oklch(0.12 0.03 220 / 0.7)",
        backdropFilter: "blur(12px) saturate(1.5)",
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: "pointer",
        boxShadow: isRunning
          ? `0 0 0 1px ${borderColor}, 0 0 20px ${glowColor}, 0 0 40px ${withAlpha(color, 0.15)}`
          : `0 0 0 1px ${borderColor}`,
        transition:
          "box-shadow 0.3s cubic-bezier(0.0, 0.0, 0.2, 1.0), border-color 0.3s cubic-bezier(0.0, 0.0, 0.2, 1.0)",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: color,
          border: "none",
          width: 8,
          height: 8,
        }}
      />

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
          {label}
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

      {isRunning && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: -1,
            borderRadius: 12,
            pointerEvents: "none",
            animation: "glow-breathe 2s ease-in-out infinite",
            boxShadow: `0 0 20px ${glowColor}`,
            opacity: "var(--glow-intensity, 0.3)",
          }}
        />
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: color,
          border: "none",
          width: 8,
          height: 8,
        }}
      />
    </motion.div>
  );
}
