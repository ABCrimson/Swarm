import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTerminal } from "#components/worker/WorkerTerminal";
import type { DomainEvent } from "#lib/event-bus";
import { workerInput } from "#lib/tauri";
import type { Worker } from "#store/types";
import { useWorkerStore } from "#store/workers";

const bus = vi.hoisted(() => ({
  handlers: new Map<string, Set<(e: DomainEvent) => void>>(),
}));
const terminals = vi.hoisted(() => [] as FakeTerminal[]);

interface FakeTerminal {
  readonly write: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly options: Record<string, unknown>;
  typed: (data: string) => void;
  resized: (size: { rows: number; cols: number }) => void;
}

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    readonly write = vi.fn();
    readonly dispose = vi.fn();
    readonly open = vi.fn();
    readonly loadAddon = vi.fn();
    typed: (data: string) => void = () => {};
    resized: (size: { rows: number; cols: number }) => void = () => {};
    // xterm defaults; read by a PTY-size sync (rows/cols + onResize).
    rows = 24;
    cols = 80;
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminals.push(this);
    }
    onData(listener: (data: string) => void) {
      this.typed = listener;
      return { dispose: vi.fn() };
    }
    onResize(listener: (size: { rows: number; cols: number }) => void) {
      this.resized = listener;
      return { dispose: vi.fn() };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss = vi.fn();
  },
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("#lib/tauri", () => ({ workerInput: vi.fn().mockResolvedValue(undefined) }));
vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: (e: DomainEvent) => void) => {
    const set = bus.handlers.get(type) ?? new Set();
    bus.handlers.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  },
}));

let seq = 0;
function emitOutput(workerId: string, data: string): void {
  const event: DomainEvent = {
    seq: ++seq,
    ts: Date.now(),
    type: "worker_output",
    payload: { workerId, data },
  };
  for (const handler of bus.handlers.get("worker_output") ?? []) handler(event);
  useWorkerStore.getState().appendOutput(workerId, data);
}

function addWorker(id: string, output: string): void {
  useWorkerStore.getState().addWorker({
    id,
    name: id,
    state: "running",
    output,
    startedAt: new Date().toISOString(),
  } as Worker);
}

beforeEach(() => {
  terminals.length = 0;
  bus.handlers.clear();
  useWorkerStore.setState({ workers: new Map(), selectedId: null });
  // jsdom has no ResizeObserver; the fit-on-resize path is not under test.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

describe("useTerminal (via WorkerTerminal)", () => {
  // Regression: remounting (worker switch, page switch) showed a blank
  // terminal until the next chunk, and never the earlier history.
  it("uses only opaque theme colors (xterm drops translucent CSS colors)", () => {
    render(<WorkerTerminal workerId="w1" />);

    const theme = terminals.at(-1)?.options.theme as Record<string, string>;
    expect(Object.keys(theme)).toContain("selectionBackground");
    for (const [key, color] of Object.entries(theme)) {
      expect(color, key).toMatch(/^oklch\([\d.]+ [\d.]+ [\d.]+\)$/);
    }
  });

  it("replays the buffered history on mount", () => {
    addWorker("w1", "$ npm install\nadded 1 package\n");
    render(<WorkerTerminal workerId="w1" />);

    expect(terminals[0]?.write).toHaveBeenCalledWith("$ npm install\nadded 1 package\n");
  });

  // Regression: deltas were computed from the store's 10k-capped string;
  // once full, old and new had equal length and nothing was ever written.
  it("keeps streaming after the 10k output buffer is full", () => {
    addWorker("w1", "x".repeat(10_000));
    render(<WorkerTerminal workerId="w1" />);
    const term = terminals[0];
    term?.write.mockClear();

    emitOutput("w1", "build step 1\n");
    emitOutput("w1", "build step 2\n");

    expect(term?.write.mock.calls).toEqual([["build step 1\n"], ["build step 2\n"]]);
    expect(useWorkerStore.getState().workers.get("w1")?.output).toHaveLength(10_000);
  });

  it("writes only its own worker's output", () => {
    addWorker("w1", "");
    addWorker("w2", "");
    render(<WorkerTerminal workerId="w1" />);

    emitOutput("w2", "not mine");
    emitOutput("w1", "mine");

    expect(terminals[0]?.write.mock.calls).toEqual([["mine"]]);
  });

  it("sends keystrokes to the worker as terminal input", () => {
    addWorker("w1", "");
    render(<WorkerTerminal workerId="w1" />);

    terminals[0]?.typed("ls\r");

    expect(workerInput).toHaveBeenCalledWith("w1", "ls\r", "terminal");
  });

  it("disposes the terminal and stops listening on unmount", () => {
    addWorker("w1", "");
    const { unmount } = render(<WorkerTerminal workerId="w1" />);

    unmount();
    emitOutput("w1", "late chunk");

    expect(terminals[0]?.dispose).toHaveBeenCalledOnce();
    expect(terminals[0]?.write).not.toHaveBeenCalled();
  });

  it("labels the terminal region for assistive technology", () => {
    addWorker("0123456789abcdef", "");
    const { getByRole } = render(<WorkerTerminal workerId="0123456789abcdef" />);

    expect(getByRole("region", { name: "Worker 01234567 Terminal" })).toBeInTheDocument();
  });

  it("does not opt into xterm's proposed API", () => {
    addWorker("w1", "");
    render(<WorkerTerminal workerId="w1" />);

    expect(terminals[0]?.options).not.toHaveProperty("allowProposedApi");
  });
});
