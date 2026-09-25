import { act, configure, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorker } from "#hooks/useWorker";
import { killWorker, pauseWorker, resumeWorker } from "#lib/tauri";
import type { Worker } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

// Like the app (main.tsx): effects run twice on mount.
configure({ reactStrictMode: true });

vi.mock("#lib/tauri", () => ({
  pauseWorker: vi.fn(),
  resumeWorker: vi.fn(),
  killWorker: vi.fn(),
}));

function seed(overrides?: Partial<Worker>): Worker {
  const worker: Worker = {
    id: crypto.randomUUID(),
    state: "running",
    name: "test-worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
  act(() => useWorkerStore.getState().addWorker(worker));
  return worker;
}

/** A backend call that stays in flight until the test settles it. */
const inFlight = (): PromiseWithResolvers<void> => Promise.withResolvers<void>();

describe("useWorker", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useWorkerStore.setState({ workers: new Map() });
    vi.mocked(pauseWorker).mockReset();
    vi.mocked(resumeWorker).mockReset();
    vi.mocked(killWorker).mockReset();
    vi.mocked(toast.error).mockClear();
    consoleError = vi.spyOn(console, "error");
  });

  afterEach(() => {
    // React reports an optimistic update made outside a transition here.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns an undefined worker when the id is not in the store", () => {
    const { result } = renderHook(() => useWorker("nonexistent-id"));

    expect(result.current.worker).toBeUndefined();
    expect(result.current.optimisticState).toBeUndefined();
  });

  it("returns the stored worker and its state when nothing is pending", () => {
    const worker = seed({ name: "alpha" });

    const { result } = renderHook(() => useWorker(worker.id));

    expect(result.current.worker).toStrictEqual(worker);
    expect(result.current.optimisticState).toBe("running");
    expect(result.current.isPending).toBe(false);
  });

  it("shows the paused state while pause is in flight, then keeps the stored state", async () => {
    const worker = seed();
    const call = inFlight();
    vi.mocked(pauseWorker).mockReturnValue(call.promise);
    const { result } = renderHook(() => useWorker(worker.id));

    act(() => result.current.pause());

    expect(pauseWorker).toHaveBeenCalledExactlyOnceWith(worker.id);
    expect(result.current.optimisticState).toBe("paused");
    expect(result.current.worker?.state).toBe("paused");
    expect(result.current.isPending).toBe(true);
    expect(useWorkerStore.getState().workers.get(worker.id)?.state).toBe("running");

    await act(async () => call.resolve());

    expect(result.current.isPending).toBe(false);
    expect(result.current.optimisticState).toBe("paused");
    expect(useWorkerStore.getState().workers.get(worker.id)?.state).toBe("paused");
  });

  it("reverts to the real state and toasts when resume fails", async () => {
    const worker = seed({ state: "paused" });
    const call = inFlight();
    vi.mocked(resumeWorker).mockReturnValue(call.promise);
    const { result } = renderHook(() => useWorker(worker.id));

    act(() => result.current.resume());
    expect(result.current.optimisticState).toBe("running");

    await act(async () => call.reject(new Error("Worker Not Found")));

    expect(result.current.optimisticState).toBe("paused");
    expect(result.current.isPending).toBe(false);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Could Not Resume Worker", {
      description: "Worker Not Found",
    });
  });

  it("kill removes the worker and its agent metadata once the backend confirms", async () => {
    const worker = seed();
    act(() => useWorkerAgentStore.getState().setAgentMetadata(worker.id, { role: "Reviewer" }));
    vi.mocked(killWorker).mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorker(worker.id));

    await act(async () => result.current.kill());

    expect(killWorker).toHaveBeenCalledExactlyOnceWith(worker.id);
    expect(useWorkerStore.getState().workers.has(worker.id)).toBe(false);
    expect(useWorkerAgentStore.getState().metadata.has(worker.id)).toBe(false);
    expect(result.current.worker).toBeUndefined();
  });

  it("kill keeps the worker when the backend refuses", async () => {
    const worker = seed();
    vi.mocked(killWorker).mockRejectedValue("Worker Not Found");
    const { result } = renderHook(() => useWorker(worker.id));

    await act(async () => result.current.kill());

    expect(useWorkerStore.getState().workers.has(worker.id)).toBe(true);
    expect(result.current.optimisticState).toBe("running");
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Could Not Kill Worker", {
      description: "Worker Not Found",
    });
  });
});
