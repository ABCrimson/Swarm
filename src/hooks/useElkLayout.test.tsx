import { act, renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockElkWorker as MockWorker } from "#hooks/elk-worker-fake";
import { useElkLayout } from "#hooks/useElkLayout";

const nodes: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, data: {} },
  { id: "b", position: { x: 0, y: 0 }, data: {} },
];
const edges: Edge[] = [{ id: "e-a-b", source: "a", target: "b" }];

describe("useElkLayout", () => {
  beforeEach(() => {
    MockWorker.reset();
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

  describe("layout watchdog", () => {
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

  describe("StrictMode remount", () => {
    // StrictMode double-invokes effects on mount in dev (mount -> cleanup
    // -> mount). When a worker topology already exists at mount time, the
    // auto-layout effect fires runLayout() on the FIRST pass, arming the
    // watchdog and starting a layout call on the first engine. The
    // construction effect's cleanup then terminates that engine's worker
    // and clears the watchdog mid-flight. The replayed auto-layout effect
    // must lay out again on the fresh engine; a guard that skipped layout
    // when the topology looked "unchanged" (an earlier version kept the
    // last fingerprint in a ref that survived the replay) left the fresh
    // engine idle and isLayouting stuck true forever. This exercises that
    // exact sequence via a real React.StrictMode wrapper.
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

  describe("superseded runs (stale-settlement guard)", () => {
    // Two layouts can genuinely overlap: the auto-layout effect fires
    // runLayout() on every topology fingerprint change, and elkjs's
    // PromisedWorker resolves each in-flight `.layout()` independently by
    // per-message id. A superseded run's late settlement must be ignored
    // entirely — it must not disarm the active run's watchdog, commit stale
    // positions, flip isLayouting, or stamp an error the active run would
    // then never clear.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const nodesWithC: Node[] = [...nodes, { id: "c", position: { x: 0, y: 0 }, data: {} }];

    /** ids of `cmd: "layout"` requests posted to `worker`, in send order. */
    function layoutRequestIds(worker: MockWorker): number[] {
      return worker.postMessage.mock.calls
        .map(([msg]) => msg as { id: number; cmd?: string })
        .filter((msg) => msg.cmd === "layout")
        .map((msg) => msg.id);
    }

    /** Delivers an elkjs-protocol response and flushes PromisedWorker's setTimeout(0) deferral. */
    async function deliver(worker: MockWorker, data: Record<string, unknown>): Promise<void> {
      await act(async () => {
        worker.onmessage?.({ data } as MessageEvent);
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    it("ignores a superseded run's late success: active watchdog stays armed and still fires", async () => {
      const { result, rerender } = renderHook(
        ({ n, e }: { n: Node[]; e: Edge[] }) => useElkLayout(n, e),
        {
          initialProps: { n: nodes, e: edges },
        },
      );
      const worker = MockWorker.instances.at(-1);
      expect(worker).toBeDefined();
      if (!worker) return;

      // Run A fired on mount; topology change starts run B while A is in flight.
      expect(layoutRequestIds(worker).length).toBe(1);
      const [idA] = layoutRequestIds(worker);
      rerender({ n: nodesWithC, e: edges });
      expect(layoutRequestIds(worker).length).toBe(2);
      expect(vi.getTimerCount()).toBe(1);

      // A's late success must not disarm B's watchdog or end B's loading state.
      await deliver(worker, {
        id: idA,
        data: {
          id: "root",
          children: [
            { id: "a", x: 1, y: 1 },
            { id: "b", x: 2, y: 2 },
          ],
        },
      });
      expect(result.current.isLayouting).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      // B hangs — its watchdog must still be alive to catch that.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(result.current.error).toBe("Layout Engine Timed Out");
      expect(result.current.isLayouting).toBe(false);
    });

    it("ignores a superseded run's late rejection: no sticky error over the active run's success", async () => {
      const { result, rerender } = renderHook(
        ({ n, e }: { n: Node[]; e: Edge[] }) => useElkLayout(n, e),
        {
          initialProps: { n: nodes, e: edges },
        },
      );
      const worker = MockWorker.instances.at(-1);
      expect(worker).toBeDefined();
      if (!worker) return;

      const [idA] = layoutRequestIds(worker);
      rerender({ n: nodesWithC, e: edges });
      const idB = layoutRequestIds(worker)[1];

      // A rejects late (elkjs rejects a request whose response carries `error`).
      await deliver(worker, { id: idA, error: { message: "boom" } });
      expect(result.current.error).toBeNull();
      expect(result.current.isLayouting).toBe(true);

      // B then succeeds — the commit must land with no error stamped.
      await deliver(worker, {
        id: idB,
        data: {
          id: "root",
          children: [
            { id: "a", x: 100, y: 50 },
            { id: "b", x: 200, y: 100 },
            { id: "c", x: 300, y: 150 },
          ],
        },
      });
      expect(result.current.error).toBeNull();
      expect(result.current.isLayouting).toBe(false);
      expect(result.current.positions.get("c")).toEqual({
        x: 300,
        y: 150,
      });
    });
  });

  describe("layout success commit (never deferred to rAF, which starves under occlusion)", () => {
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
      // test must fail (isLayouting stuck true, positions never update).
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
      expect(result.current.positions.get("a")).toEqual({
        x: 100,
        y: 50,
      });
      expect(result.current.positions.get("b")).toEqual({
        x: 200,
        y: 100,
      });
      expect(rafSpy).not.toHaveBeenCalled();
    });
  });
});
