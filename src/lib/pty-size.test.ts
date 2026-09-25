import type { IDisposable } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncPtySize } from "#lib/pty-size";
import { resizeWorker } from "#lib/tauri";

vi.mock("#lib/tauri", () => ({ resizeWorker: vi.fn() }));

// Block body: a function returned from beforeEach is a teardown, which
// Vitest would call (running the mock) after each test.
beforeEach(() => {
  vi.mocked(resizeWorker).mockReset().mockResolvedValue(undefined);
});

const WORKER = "550e8400-e29b-41d4-a716-446655440000";

/** The slice of an xterm.js `Terminal` that `syncPtySize` uses. */
function fakeTerminal(rows: number, cols: number) {
  let listener: ((size: { rows: number; cols: number }) => void) | undefined;
  const subscription: IDisposable = { dispose: vi.fn(() => (listener = undefined)) };
  return {
    rows,
    cols,
    onResize: vi.fn((next: typeof listener) => {
      listener = next;
      return subscription;
    }),
    fire: (size: { rows: number; cols: number }) => listener?.(size),
    subscription,
  };
}

describe("syncPtySize", () => {
  it("sends the current size at once, then every resize", () => {
    const terminal = fakeTerminal(24, 80);
    syncPtySize(terminal, WORKER);
    expect(resizeWorker).toHaveBeenLastCalledWith(WORKER, 24, 80);

    terminal.fire({ rows: 50, cols: 160 });
    expect(resizeWorker).toHaveBeenLastCalledWith(WORKER, 50, 160);
    expect(resizeWorker).toHaveBeenCalledTimes(2);
  });

  it("stops following the terminal once disposed", () => {
    const terminal = fakeTerminal(24, 80);
    const sync = syncPtySize(terminal, WORKER);
    sync.dispose();
    terminal.fire({ rows: 10, cols: 10 });

    expect(terminal.subscription.dispose).toHaveBeenCalledOnce();
    expect(resizeWorker).toHaveBeenCalledOnce();
  });

  it("swallows a failed resize (the worker may already be gone)", async () => {
    vi.mocked(resizeWorker).mockRejectedValue(new Error("Worker `x` not found"));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      syncPtySize(fakeTerminal(24, 80), WORKER);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
