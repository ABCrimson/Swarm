import { useRef } from "react";
import { useTerminal } from "#hooks/useTerminal";
import "@xterm/xterm/css/xterm.css";

interface WorkerTerminalProps {
  /** The worker ID whose terminal to display. */
  readonly workerId: string;
}

/**
 * A worker's interactive terminal: a full-size, labelled region that
 * `useTerminal` mounts an xterm.js instance into.
 */
export function WorkerTerminal({ workerId }: WorkerTerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLElement>(null);

  useTerminal({ workerId, containerRef });

  return (
    <section
      ref={containerRef}
      aria-label={`Worker ${workerId.slice(0, 8)} Terminal`}
      className="size-full min-h-0 overflow-hidden bg-void"
    />
  );
}
