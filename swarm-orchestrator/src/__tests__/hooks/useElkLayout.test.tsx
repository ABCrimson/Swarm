import { act, renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElkLayout } from "#hooks/useElkLayout";

/**
 * Minimal mock of the DOM `Worker` API. A real end-to-end elkjs worker test
 * is impractical under jsdom (jsdom has no Worker implementation and can't
 * evaluate a module worker script), so this mostly exercises the hook's
 * failure-handling contract: when the worker the hook constructs fires
 * `onerror`/`onmessageerror`, the hook must surface an error and clear
 * `isLayouting` instead of hanging forever (the Task 4 regression).
 *
 * When `MockWorker.autoRespondLayout` is set, `postMessage` also speaks just
 * enough of elkjs's own `{cmd, id}` request/response protocol (see
 * elkjs's `PromisedWorker`) to resolve a real `elk.layout()` call — needed
 * to exercise the success path (fix/feedback-batch-1 item: synchronous
 * layout commit) without a real worker.
 */
class MockWorker {
  static instances: MockWorker[] = [];
  static autoRespondLayout = false;

  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  postMessage = vi.fn(
    (msg: { id: number; cmd?: string; graph?: { children?: { id: string }[] } }) => {
      if (!MockWorker.autoRespondLayout || msg.cmd !== "layout") return;
      const children = (msg.graph?.children ?? []).map((child, i) => ({
        id: child.id,
        x: (i + 1) * 100,
        y: (i + 1) * 50,
      }));
      this.onmessage?.({
        data: { id: msg.id, data: { id: "root", children } },
      } as MessageEvent);
    },
  );
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
    MockWorker.autoRespondLayout = false;
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

  describe("layout watchdog (Task 8 item 5)", () => {
    // MockWorker.postMessage is a no-op that never calls back into
    // elkjs's own onmessage handler, so `elk.layout()` hangs forever here
    // by construction — exactly the "worker neither errors nor ever
    // responds" case the watchdog exists to cover.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("surfaces a distinct, Title-Cased timeout error and clears isLayouting when elk.layout() never settles within 10s", async () => {
      const { result } = renderHook(() => useElkLayout(nodes, edges));
      expect(result.current.isLayouting).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(result.current.error).toBe("Layout Engine Timed Out");
      expect(result.current.isLayouting).toBe(false);
    });

    it("does not fire the watchdog before the 10s deadline", async () => {
      const { result } = renderHook(() => useElkLayout(nodes, edges));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_999);
      });

      expect(result.current.error).toBeNull();
      expect(result.current.isLayouting).toBe(true);
    });

    it("clears the watchdog timer on unmount, leaking no pending timers", () => {
      const { unmount } = renderHook(() => useElkLayout(nodes, edges));
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not let a later-firing watchdog overwrite a worker-crash error that already resolved isLayouting", async () => {
      const { result } = renderHook(() => useElkLayout(nodes, edges));
      const worker = MockWorker.instances.at(-1);

      act(() => {
        worker?.onerror?.(new ErrorEvent("error", { message: "boom" }));
      });
      expect(result.current.error).toBe("Layout Engine Failed To Start");

      // If the watchdog leaked (wasn't cleared by the onerror path), this
      // advance would let it fire and stomp the error above.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(result.current.error).toBe("Layout Engine Failed To Start");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the previous watchdog when runLayout is retried, without double-firing", async () => {
      const { result } = renderHook(() => useElkLayout(nodes, edges));

      act(() => {
        result.current.runLayout();
      });
      expect(vi.getTimerCount()).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(result.current.error).toBe("Layout Engine Timed Out");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("StrictMode remount (fix/feedback-batch-1 item 1)", () => {
    // StrictMode double-invokes effects on mount in dev (mount -> cleanup
    // -> mount). When a worker topology already exists at mount time, the
    // auto-layout effect fires runLayout() on the FIRST pass (fingerprint
    // "" -> topology), arming the watchdog and starting a layout call on
    // the first engine. The construction effect's cleanup then terminates
    // that engine's worker and clears the watchdog mid-flight. On the
    // replay mount a fresh engine is created — but `prevFingerprintRef` is
    // a ref, so without resetting it in that cleanup, the replayed
    // auto-layout effect sees no fingerprint change (the ref survived the
    // replay) and skips runLayout() entirely, leaving the fresh engine
    // idle, the watchdog dead, and isLayouting stuck true forever. This
    // exercises that exact sequence via a real React.StrictMode wrapper.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-triggers layout on the fresh engine after a StrictMode replay instead of leaving isLayouting stuck", async () => {
      const { result } = renderHook(() => useElkLayout(nodes, edges), {
        wrapper: StrictMode,
      });

      // The worker factory must have been invoked twice: once for the
      // pre-replay engine, once for the surviving post-replay engine.
      expect(MockWorker.instances.length).toBe(2);

      const secondWorker = MockWorker.instances[1];
      const layoutCallsOnSecondWorker = secondWorker.postMessage.mock.calls.filter(
        ([msg]) => (msg as { cmd?: string } | undefined)?.cmd === "layout",
      );

      // The replayed auto-layout effect must have actually re-requested a
      // layout on the second (surviving) engine — not just constructed it
      // and left it idle.
      expect(layoutCallsOnSecondWorker.length).toBe(1);

      // A fresh watchdog must be armed for that second layout request. If
      // the bug were present, runLayout() would never have been called on
      // the second engine, so no watchdog would be running at all here.
      expect(vi.getTimerCount()).toBe(1);
      expect(result.current.isLayouting).toBe(true);

      // Prove the second engine is genuinely alive (not orphaned): its
      // watchdog fires on schedule instead of leaving isLayouting stuck
      // `true` forever with no error, ever.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(result.current.error).toBe("Layout Engine Timed Out");
      expect(result.current.isLayouting).toBe(false);
    });
  });

  describe("layout success commit (fix/feedback-batch-1: rAF deferral starves under occlusion/CDP)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("commits layout state even when requestAnimationFrame never fires", async () => {
      // Chromium suppresses rAF callbacks for occluded/minimized windows (and
      // under CDP evaluation pressure). Stub it to a no-op that never invokes
      // its callback, simulating that starvation deterministically: if the
      // hook's success handler still depends on rAF to commit state, this
      // test must fail (isLayouting stuck true, layoutedNodes never update).
      const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);
      MockWorker.autoRespondLayout = true;

      const { result } = renderHook(() => useElkLayout(nodes, edges));
      expect(result.current.isLayouting).toBe(true);

      // elkjs's own PromisedWorker defers delivery of the mocked response by
      // one macrotask (`setTimeout(fn, 0)`); flush it deterministically
      // instead of polling on real timers.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(result.current.isLayouting).toBe(false);
      expect(result.current.layoutedNodes.find((n) => n.id === "a")?.position).toEqual({
        x: 100,
        y: 50,
      });
      expect(result.current.layoutedNodes.find((n) => n.id === "b")?.position).toEqual({
        x: 200,
        y: 100,
      });
      expect(result.current.layoutedEdges).toBe(edges);
      expect(rafSpy).not.toHaveBeenCalled();
    });
  });
});
