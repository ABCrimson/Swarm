import { act, renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElkLayout } from "#hooks/useElkLayout";

/**
 * Minimal mock of the DOM `Worker` API. A real end-to-end elkjs worker test
 * is impractical under jsdom (jsdom has no Worker implementation and can't
 * evaluate a module worker script), so this only exercises the hook's
 * failure-handling contract: when the worker the hook constructs fires
 * `onerror`/`onmessageerror`, the hook must surface an error and clear
 * `isLayouting` instead of hanging forever (the Task 4 regression).
 */
class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }
}

const nodes: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, data: {} },
  { id: "b", position: { x: 0, y: 0 }, data: {} },
];
const edges: Edge[] = [{ id: "e-a-b", source: "a", target: "b" }];

describe("useElkLayout", () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("starts with no error and spawns exactly one (non-nested) worker", () => {
    const { result } = renderHook(() => useElkLayout(nodes, edges));

    expect(result.current.error).toBeNull();
    expect(MockWorker.instances.length).toBe(1);
  });

  it("surfaces a Title-Cased error and clears isLayouting when the worker errors", () => {
    const { result } = renderHook(() => useElkLayout(nodes, edges));
    const worker = MockWorker.instances.at(-1);
    expect(worker).toBeDefined();

    act(() => {
      worker?.onerror?.(new ErrorEvent("error", { message: "boom" }));
    });

    expect(result.current.error).toBe("Layout Engine Failed To Start");
    expect(result.current.isLayouting).toBe(false);
  });

  it("surfaces an error and clears isLayouting when the worker sends an unreadable message", () => {
    const { result } = renderHook(() => useElkLayout(nodes, edges));
    const worker = MockWorker.instances.at(-1);
    expect(worker).toBeDefined();

    act(() => {
      worker?.onmessageerror?.(new MessageEvent("messageerror"));
    });

    expect(result.current.error).toBe("Layout Engine Failed To Start");
    expect(result.current.isLayouting).toBe(false);
  });

  it("clears the error and resumes layouting when runLayout is retried", () => {
    const { result } = renderHook(() => useElkLayout(nodes, edges));
    const worker = MockWorker.instances.at(-1);

    act(() => {
      worker?.onerror?.(new ErrorEvent("error", { message: "boom" }));
    });
    expect(result.current.error).toBe("Layout Engine Failed To Start");

    act(() => {
      result.current.runLayout();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.isLayouting).toBe(true);
  });

  it("terminates the worker on unmount", () => {
    const { unmount } = renderHook(() => useElkLayout(nodes, edges));
    const worker = MockWorker.instances.at(-1);

    unmount();

    expect(worker?.terminate).toHaveBeenCalled();
  });
});
