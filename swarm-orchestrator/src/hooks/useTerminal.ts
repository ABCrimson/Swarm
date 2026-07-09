import { useResizeObserver } from "@crimson_dev/use-resize-observer";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { RefObject } from "react";
import { useEffect, useRef } from "react";
import { workerInput } from "#lib/tauri";
import { useWorkerStore } from "#store/workers";

/**
 * OKLCH terminal theme. All colors are specified in OKLCH color space.
 *
 * 16-color palette covers the standard ANSI color range plus bright variants.
 */
const TERMINAL_THEME = {
  background: "oklch(0.06 0.02 220)",
  foreground: "oklch(0.82 0.04 220)",
  cursor: "oklch(0.78 0.18 205)",
  cursorAccent: "oklch(0.06 0.02 220)",
  selectionBackground: "oklch(0.78 0.18 205 / 0.25)",
  selectionForeground: "oklch(0.92 0.02 220)",
  // Standard ANSI colors (0-7)
  black: "oklch(0.15 0.02 220)",
  red: "oklch(0.60 0.20 15)",
  green: "oklch(0.68 0.18 145)",
  yellow: "oklch(0.75 0.16 80)",
  blue: "oklch(0.62 0.18 250)",
  magenta: "oklch(0.62 0.20 320)",
  cyan: "oklch(0.72 0.12 195)",
  white: "oklch(0.82 0.04 220)",
  // Bright ANSI colors (8-15)
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
  /** Worker ID to connect terminal input/output to. */
  workerId: string;
  /** Container element ref for mounting the terminal. */
  containerRef: RefObject<HTMLDivElement | null>;
}

interface UseTerminalReturn {
  /** The xterm Terminal instance (available after mount). */
  terminal: Terminal | null;
}

/**
 * Hook managing an xterm.js terminal instance with WebGL rendering.
 *
 * - Creates a Terminal with `allowProposedApi: true` (required for beta).
 * - Loads FitAddon first, then WebglAddon for GPU-accelerated rendering.
 * - Uses `@crimson_dev/use-resize-observer` to auto-fit on container resize.
 * - Sends input data to the Rust backend via `invoke("worker_input")`.
 * - Subscribes to the worker store for output data.
 * - Disposes the terminal on unmount.
 */
export function useTerminal({ workerId, containerRef }: UseTerminalOptions): UseTerminalReturn {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Resize observer to auto-fit terminal to container
  useResizeObserver({
    ref: containerRef,
    onResize() {
      fitAddonRef.current?.fit();
    },
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create terminal with OKLCH theme
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
      cursorStyle: "bar",
      theme: TERMINAL_THEME,
      scrollback: 10_000,
      convertEol: true,
    });

    termRef.current = term;

    // Load order: FitAddon -> open -> WebglAddon
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    term.open(container);

    // WebGL2 renderer (mandatory for performance)
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
    });
    term.loadAddon(webglAddon);

    // Initial fit
    fitAddon.fit();

    // Input: send keystrokes to the backend
    const inputDisposable = term.onData((data) => {
      void workerInput(workerId, data);
    });

    // Subscribe to worker output from the store
    const unsubscribeOutput = useWorkerStore.subscribe(
      (s) => s.workers.get(workerId)?.output,
      (output, prevOutput) => {
        if (output && output !== prevOutput) {
          // Write only the new delta
          const delta = prevOutput ? output.slice(prevOutput.length) : output;
          if (delta) {
            term.write(delta);
          }
        }
      },
    );

    return () => {
      inputDisposable.dispose();
      unsubscribeOutput();
      webglAddon.dispose();
      fitAddon.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [workerId, containerRef]);

  return { terminal: termRef.current };
}
