// useWorkerEvents against the real event bus: Rust-shaped envelopes go
// in through the `swarm://events` listener, and the stores come out.

import { configure, renderHook, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkerEvents } from "#hooks/useWorkerEvents";
import { connectEventBus, resetEventBus } from "#lib/event-bus";
import { useSessionStore } from "#store/sessions";
import type { Worker } from "#store/types";
import { selectedWorkerIdAtom } from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

// Like the app (main.tsx): effects run twice on mount.
configure({ reactStrictMode: true });

const listeners = new Map<string, (payload: unknown) => void>();
const mockListWorkers = vi.fn<() => Promise<Worker[]>>();
const mockSessionRemoveWorker = vi.fn();

vi.mock("#lib/tauri", () => ({
  listen: async (event: string, handler: (payload: unknown) => void) => {
    listeners.set(event, handler);
    return () => listeners.delete(event);
  },
  invoke: vi.fn(),
  listWorkers: () => mockListWorkers(),
  sessionRemoveWorker: (...args: unknown[]) => mockSessionRemoveWorker(...args),
}));

let seq = 0;
function emit(type: string, payload: unknown): void {
  seq += 1;
  listeners.get("swarm://events")?.({ seq, ts: seq, type, payload });
}

const W1 = "11111111-2222-4333-8444-555555555555";
const W2 = "22222222-3333-4444-8555-666666666666";
const S1 = "99999999-8888-4777-8666-555555555555";
const S2 = "aaaaaaaa-1111-4222-8333-444444444444";

function worker(id: string, overrides?: Partial<Worker>): Worker {
  return {
    id,
    state: "running",
    name: `Worker ${id.slice(0, 4)}`,
    startedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function session(id: string, workerIds: string[]): void {
  const now = new Date().toISOString();
  useSessionStore
    .getState()
    .addSession({ id, name: id, workerIds, createdAt: now, updatedAt: now });
}

describe("useWorkerEvents", () => {
  beforeEach(async () => {
    seq = 0;
    listeners.clear();
    resetEventBus();
    useWorkerStore.setState({ workers: new Map() });
    useWorkerAgentStore.setState({ metadata: new Map() });
    useSessionStore.setState({ sessions: new Map() });
    getDefaultStore().set(selectedWorkerIdAtom, null);
    mockListWorkers.mockReset().mockResolvedValue([]);
    mockSessionRemoveWorker.mockReset().mockResolvedValue(undefined);
    await connectEventBus();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("startup hydration", () => {
    it("loads the workers the backend is already running", async () => {
      mockListWorkers.mockResolvedValue([worker(W1), worker(W2, { state: "paused" })]);

      renderHook(() => useWorkerEvents());

      await waitFor(() => expect(useWorkerStore.getState().workers.size).toBe(2));
      expect(useWorkerStore.getState().workers.get(W2)?.state).toBe("paused");
    });

    it("does not bring back a worker killed while the list was in flight", async () => {
      const list = Promise.withResolvers<Worker[]>();
      mockListWorkers.mockReturnValue(list.promise);
      renderHook(() => useWorkerEvents());

      emit("worker_killed", { workerId: W1 });
      list.resolve([worker(W1), worker(W2)]);

      await waitFor(() => expect(useWorkerStore.getState().workers.has(W2)).toBe(true));
      expect(useWorkerStore.getState().workers.has(W1)).toBe(false);
    });

    it("keeps a worker that a live event added before the list arrived", async () => {
      const list = Promise.withResolvers<Worker[]>();
      mockListWorkers.mockReturnValue(list.promise);
      renderHook(() => useWorkerEvents());

      emit("worker_spawned", { workerId: W1, name: "Live", pid: 7, isolation: "none" });
      list.resolve([worker(W1, { name: "Stale" })]);

      await waitFor(() => expect(mockListWorkers).toHaveBeenCalled());
      await list.promise;
      expect(useWorkerStore.getState().workers.get(W1)?.name).toBe("Live");
    });

    it("logs a failed load and keeps working", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      mockListWorkers.mockRejectedValue(new Error("Not Connected To The SWARM Daemon."));
      renderHook(() => useWorkerEvents());

      await waitFor(() =>
        expect(error).toHaveBeenCalledWith(
          "useWorkerEvents: could not load workers",
          expect.any(Error),
        ),
      );
      emit("worker_spawned", { workerId: W1, name: "Later", pid: null });
      expect(useWorkerStore.getState().workers.has(W1)).toBe(true);
    });
  });

  it("adds a spawned worker, omitting a null pid", () => {
    renderHook(() => useWorkerEvents());

    emit("worker_spawned", { workerId: W1, name: "Alpha", pid: null, isolation: "worktree" });

    const stored = useWorkerStore.getState().workers.get(W1);
    expect(stored).toMatchObject({ id: W1, name: "Alpha", state: "running" });
    expect(stored).not.toHaveProperty("pid");
  });

  it("applies worker_output, worker_state and worktree_created", () => {
    useWorkerStore.getState().addWorker(worker(W1));
    renderHook(() => useWorkerEvents());

    emit("worker_output", { workerId: W1, data: "hello" });
    emit("worker_state", { workerId: W1, state: "paused" });
    emit("worktree_created", {
      workerId: W1,
      sessionId: null,
      repoRoot: "/repo",
      worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-11112222",
      branch: "swarm/isolated-worker-11112222",
      baseCommit: "deadbeef",
    });

    expect(useWorkerStore.getState().workers.get(W1)).toMatchObject({
      output: "hello",
      state: "paused",
      worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-11112222",
      branch: "swarm/isolated-worker-11112222",
    });
  });

  it("ignores an event whose payload does not match the Rust shape", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useWorkerStore.getState().addWorker(worker(W1));
    renderHook(() => useWorkerEvents());

    emit("worker_state", { workerId: W1, state: "zombie" });

    expect(useWorkerStore.getState().workers.get(W1)?.state).toBe("running");
  });

  describe("worker_killed", () => {
    it("removes the worker, its agent metadata and the selection pointing at it", () => {
      useWorkerStore.getState().addWorker(worker(W1));
      useWorkerAgentStore.getState().setAgentMetadata(W1, { role: "coder", model: "sonnet" });
      getDefaultStore().set(selectedWorkerIdAtom, W1);
      renderHook(() => useWorkerEvents());

      emit("worker_killed", { workerId: W1 });

      expect(useWorkerStore.getState().workers.has(W1)).toBe(false);
      expect(useWorkerAgentStore.getState().metadata.has(W1)).toBe(false);
      expect(getDefaultStore().get(selectedWorkerIdAtom)).toBeNull();
    });

    it("keeps the selection when another worker is killed", () => {
      getDefaultStore().set(selectedWorkerIdAtom, W2);
      renderHook(() => useWorkerEvents());

      emit("worker_killed", { workerId: W1 });

      expect(getDefaultStore().get(selectedWorkerIdAtom)).toBe(W2);
    });

    it("prunes the worker from every session that lists it, and only those", () => {
      session(S1, [W1]);
      session(S2, [W2]);
      renderHook(() => useWorkerEvents());

      emit("worker_killed", { workerId: W1 });

      expect(mockSessionRemoveWorker).toHaveBeenCalledExactlyOnceWith(S1, W1);
    });

    it("prunes it from each of several sessions", () => {
      session(S1, [W1]);
      session(S2, [W1, W2]);
      renderHook(() => useWorkerEvents());

      emit("worker_killed", { workerId: W1 });

      expect(mockSessionRemoveWorker.mock.calls).toStrictEqual([
        [S1, W1],
        [S2, W1],
      ]);
    });
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useWorkerEvents());
    unmount();

    emit("worker_spawned", { workerId: W1, name: "After", pid: null });

    expect(useWorkerStore.getState().workers.size).toBe(0);
  });
});
