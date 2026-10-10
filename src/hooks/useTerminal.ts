import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { onEvent } from "#lib/event-bus";
import { syncPtySize } from "#lib/pty-size";
import { workerInput } from "#lib/tauri";
import { useWorkerStore } from "#store/workers";

/**
 * OKLCH terminal theme: background, foreground, cursor, selection and the
 * 16-color ANSI palette (standard 0-7, bright 8-15).
 *
 * Every value must be opaque. xterm parses anything but hex/rgb() by
 * painting it on a canvas, rejects the result unless alpha is 255, and
 * then silently uses its default color — so the selection is the plasma
 * accent pre-blended at 25% over the background, not a translucent color.
 */
const TERMINAL_THEME = {
  background: "oklch(0.06 0.02 220)",
  foreground: "oklch(0.82 0.04 220)",
  cursor: "oklch(0.78 0.18 205)",
  cursorAccent: "oklch(0.06 0.02 220)",
  selectionBackground: "oklch(0.25 0.06 208)",
  selectionForeground: "oklch(0.92 0.02 220)",
  black: "oklch(0.15 0.02 220)",
  red: "oklch(0.60 0.20 15)",
  green: "oklch(0.68 0.18 145)",
  yellow: "oklch(0.75 0.16 80)",
  blue: "oklch(0.62 0.18 250)",
  magenta: "oklch(0.62 0.20 320)",
  cyan: "oklch(0.72 0.12 195)",
  white: "oklch(0.82 0.04 220)",
  brightBlack: "oklch(0.38 0.02 220)",
  brightRed: "oklch(0.72 0.22 15)",
  brightGreen: "oklch(0.78 0.20 145)",
  brightYellow: "oklch(0.85 0.18 80)",
  brightBlue: "oklch(0.72 0.20 250)",
  brightMagenta: "oklch(0.72 0.22 320)",
  brightCyan: "oklch(0.82 0.14 195)",
  brightWhite: "oklch(0.92 0.02 220)",
} as const;

interface UseTerminalOptions {
  /** Worker whose PTY this terminal shows and types into. */
  readonly workerId: string;
  /** Element the terminal mounts into; must be rendered on the first commit. */
  readonly containerRef: RefObject<HTMLElement | null>;
}

/**
 * Mounts an xterm.js terminal for a worker's PTY into `containerRef`.
 *
 * - Output: on mount the worker store's buffered history (its last 10,000
 *   characters) is written first, then every `worker_output` chunk for
 *   this worker is written straight from the ordered event bus. The live
 *   path never diffs the store's capped string (`OUTPUT_BUFFER_CHARS` in
 *   `#store/workers`): once it is full, old and new strings have equal
 *   length, so a diff would always be empty.
 * - Input: keystrokes go to the backend with `workerInput(…, "terminal")`
 *   (human input: no provenance, never persisted). Nothing is sent once
 *   the worker is in the `error` state (its shell has exited and the
 *   backend refuses input), and a refused write is logged once instead of
 *   surfacing as an unhandled rejection per keystroke.
 * - Size: the worker's PTY follows the terminal's grid (`syncPtySize`),
 *   so full-screen programs lay out for the box the user sees.
 * - Rendering: the WebGL renderer when the context is available (it
 *   disposes itself on context loss and xterm falls back to the DOM
 *   renderer); the grid is refit whenever the container resizes.
 *
 * Everything is disposed on unmount or when `workerId` changes.
 */
export function useTerminal({ workerId, containerRef }: UseTerminalOptions): void {
  const fitAddonRef = useRef<FitAddon | null>(null);

  useResizeObserver({
    ref: containerRef,
    onResize() {
      fitAddonRef.current?.fit();
    },
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: TERMINAL_THEME,
      scrollback: 10_000,
      convertEol: true,
    });

    // Load order: FitAddon -> open -> WebglAddon (it needs the DOM).
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(container);

    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    try {
      term.loadAddon(webglAddon);
    } catch (err) {
      // No WebGL2 context: xterm keeps its DOM renderer.
      console.warn("[terminal] WebGL renderer unavailable:", err);
    }
    fitAddon.fit();
    const ptySize = syncPtySize(term, workerId);

    // History first, then the live stream. Both happen in this one
    // synchronous block, so no chunk can land in between and be lost
    // or written twice.
    const history = useWorkerStore.getState().workers.get(workerId)?.output;
    if (history) term.write(history);
    const offOutput = onEvent("worker_output", ({ payload }) => {
      if (payload.workerId === workerId) term.write(payload.data);
    });

    let inputRefusedLogged = false;
    const input = term.onData((data) => {
      if (useWorkerStore.getState().workers.get(workerId)?.state === "error") return;
      workerInput(workerId, data, "terminal").catch((err: unknown) => {
        if (inputRefusedLogged) return;
        inputRefusedLogged = true;
        console.warn(`[terminal] worker ${workerId} refused input:`, err);
      });
    });

    return () => {
      offOutput();
      input.dispose();
      ptySize.dispose();
      term.dispose();
      fitAddonRef.current = null;
    };
  }, [workerId, containerRef]);
}
