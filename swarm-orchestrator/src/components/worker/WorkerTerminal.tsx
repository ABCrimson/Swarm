import { useRef } from "react";
import { useTerminal } from "#hooks/useTerminal";
import "@xterm/xterm/css/xterm.css";

interface WorkerTerminalProps {
  /** The worker ID whose terminal to display. */
  readonly workerId: string;
}

/**
 * Terminal component for a worker process.
 *
 * Renders a full-height/width container and mounts an xterm.js terminal
 * connected to the specified worker via the `useTerminal` hook.
 */
export function WorkerTerminal({ workerId }: WorkerTerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  useTerminal({ workerId, containerRef });

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: "oklch(0.06 0.02 220)",
      }}
    />
  );
}
