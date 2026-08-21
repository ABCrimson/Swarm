import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorker } from "#hooks/useWorker";
import type { Worker } from "#store/types";
import { useWorkerStore } from "#store/workers";

// Mock the Tauri IPC commands used by useWorker
vi.mock("#lib/tauri", () => ({
  pauseWorker: vi.fn().mockResolvedValue(undefined),
  resumeWorker: vi.fn().mockResolvedValue(undefined),
  killWorker: vi.fn().mockResolvedValue(undefined),
  spawnWorker: vi.fn().mockResolvedValue({
    id: "mock-id",
    state: "idle",
    name: "mock-worker",
    startedAt: new Date().toISOString(),
  }),
}));

function createWorker(overrides?: Partial<Worker>): Worker {
  return {
    id: crypto.randomUUID(),
    state: "running",
    name: "test-worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStore(): void {
  act(() => {
    const state = useWorkerStore.getState();
    for (const [id] of state.workers) {
      state.removeWorker(id);
    }
    state.selectWorker(null);
  });
}

describe("useWorker", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("returns undefined worker when id does not exist in the store", () => {
    const { result } = renderHook(() => useWorker("nonexistent-id"));

    expect(result.current.worker).toBeUndefined();
  });

  it("returns the worker data when it exists in the store", () => {
    const worker = createWorker({ name: "alpha" });
    act(() => {
      useWorkerStore.getState().addWorker(worker);
    });

    const { result } = renderHook(() => useWorker(worker.id));

    expect(result.current.worker).toBeDefined();
    expect(result.current.worker?.name).toBe("alpha");
    expect(result.current.worker?.state).toBe("running");
  });

  it("exposes pause, resume, and kill action functions", () => {
    const worker = createWorker();
    act(() => {
      useWorkerStore.getState().addWorker(worker);
    });

    const { result } = renderHook(() => useWorker(worker.id));

    expect(typeof result.current.pause).toBe("function");
    expect(typeof result.current.resume).toBe("function");
    expect(typeof result.current.kill).toBe("function");
  });

  it("returns optimisticState matching worker state initially", () => {
    const worker = createWorker({ state: "running" });
    act(() => {
      useWorkerStore.getState().addWorker(worker);
    });

    const { result } = renderHook(() => useWorker(worker.id));

    expect(result.current.optimisticState).toBe("running");
  });
});
