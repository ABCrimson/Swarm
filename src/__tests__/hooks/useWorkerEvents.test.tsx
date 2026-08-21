// ── Agent-metadata leak fix (fix wave, item 11) ──────
//
// useWorker's kill() path already cleaned up useWorkerAgentStore, but a
// worker that exits on its own (crash, process exit) only ever reaches
// the worker_killed event — without this fix, a self-exiting templated
// worker's role/model/systemPrompt entry would leak in the agent store
// for the app's lifetime.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkerEvents } from "#hooks/useWorkerEvents";
import { useSessionStore } from "#store/sessions";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

type Handler = (e: { payload: unknown }) => void;

const registered = new Map<string, Handler>();

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    registered.set(type, handler);
    return () => registered.delete(type);
  },
}));

// Spies on the session_remove_worker IPC wrapper the worker_killed
// handler now calls — this hook only ever needs sessionRemoveWorker
// from #lib/tauri, so a full-replacement mock is safe.
const mockSessionRemoveWorker = vi.fn().mockResolvedValue(undefined);
vi.mock("#lib/tauri", () => ({
  sessionRemoveWorker: (...args: unknown[]) => mockSessionRemoveWorker(...args),
}));

function resetStores(): void {
  for (const [id] of useWorkerStore.getState().workers) useWorkerStore.getState().removeWorker(id);
  for (const [id] of useWorkerAgentStore.getState().metadata) {
    useWorkerAgentStore.getState().removeAgentMetadata(id);
  }
  for (const [id] of useSessionStore.getState().sessions)
    useSessionStore.getState().removeSession(id);
}

describe("useWorkerEvents", () => {
  beforeEach(() => {
    resetStores();
    registered.clear();
    mockSessionRemoveWorker.mockClear();
  });
  afterEach(resetStores);

  it("removes agent metadata when a worker is killed, alongside the worker record", () => {
    const workerId = "11111111-2222-3333-8444-555555555555";
    useWorkerStore.getState().addWorker({
      id: workerId,
      state: "running",
      name: "Templated Worker",
      startedAt: new Date().toISOString(),
    });
    useWorkerAgentStore.getState().setAgentMetadata(workerId, {
      role: "coder",
      model: "sonnet",
      systemPrompt: "You write code.",
    });

    renderHook(() => useWorkerEvents());
    registered.get("worker_killed")?.({ payload: { workerId } });

    expect(useWorkerStore.getState().workers.has(workerId)).toBe(false);
    expect(useWorkerAgentStore.getState().metadata.has(workerId)).toBe(false);
  });

  it("is a no-op for a worker with no agent metadata (plain, non-templated worker)", () => {
    const workerId = "22222222-3333-4444-8555-666666666666";
    useWorkerStore.getState().addWorker({
      id: workerId,
      state: "running",
      name: "Plain Worker",
      startedAt: new Date().toISOString(),
    });

    renderHook(() => useWorkerEvents());
    expect(() => registered.get("worker_killed")?.({ payload: { workerId } })).not.toThrow();

    expect(useWorkerStore.getState().workers.has(workerId)).toBe(false);
  });

  it("mirrors worktreePath/branch onto the worker store on worktree_created", () => {
    const workerId = "33333333-4444-5555-8666-777777777777";
    useWorkerStore.getState().addWorker({
      id: workerId,
      state: "running",
      name: "Isolated Worker",
      startedAt: new Date().toISOString(),
    });

    renderHook(() => useWorkerEvents());
    registered.get("worktree_created")?.({
      payload: {
        workerId,
        repoRoot: "/repo",
        worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-11112222",
        branch: "swarm/isolated-worker-11112222",
        baseCommit: "deadbeef",
      },
    });

    const worker = useWorkerStore.getState().workers.get(workerId);
    expect(worker?.worktreePath).toBe("/home/user/.swarm/worktrees/repo-abcd1234/w-11112222");
    expect(worker?.branch).toBe("swarm/isolated-worker-11112222");
  });

  // ── session_remove_worker pruning (workerIds stops growing forever) ──

  it("calls session_remove_worker for every session that still lists the killed worker", () => {
    const workerId = "44444444-5555-6666-8777-888888888888";
    const sessionId = "99999999-8888-7777-8666-555555555555";
    const now = new Date().toISOString();
    useSessionStore.getState().addSession({
      id: sessionId,
      name: "Test Session",
      workerIds: [workerId],
      createdAt: now,
      updatedAt: now,
    });
    useWorkerStore.getState().addWorker({
      id: workerId,
      state: "running",
      name: "Session Worker",
      startedAt: now,
    });

    renderHook(() => useWorkerEvents());
    registered.get("worker_killed")?.({ payload: { workerId } });

    expect(mockSessionRemoveWorker).toHaveBeenCalledTimes(1);
    expect(mockSessionRemoveWorker).toHaveBeenCalledWith(sessionId, workerId);
  });

  it("calls session_remove_worker for every session containing the worker, not just the first", () => {
    const workerId = "55555555-6666-7777-8888-999999999999";
    const sessionA = "aaaaaaaa-1111-2222-8333-444444444444";
    const sessionB = "bbbbbbbb-1111-2222-8333-444444444444";
    const now = new Date().toISOString();
    useSessionStore.getState().addSession({
      id: sessionA,
      name: "A",
      workerIds: [workerId],
      createdAt: now,
      updatedAt: now,
    });
    useSessionStore.getState().addSession({
      id: sessionB,
      name: "B",
      workerIds: [workerId],
      createdAt: now,
      updatedAt: now,
    });

    renderHook(() => useWorkerEvents());
    registered.get("worker_killed")?.({ payload: { workerId } });

    expect(mockSessionRemoveWorker).toHaveBeenCalledWith(sessionA, workerId);
    expect(mockSessionRemoveWorker).toHaveBeenCalledWith(sessionB, workerId);
    expect(mockSessionRemoveWorker).toHaveBeenCalledTimes(2);
  });

  it("does not call session_remove_worker for a session that never listed the killed worker", () => {
    const workerId = "aaaaaaaa-bbbb-cccc-8ddd-eeeeeeeeeeee";
    const sessionId = "bbbbbbbb-cccc-dddd-8eee-ffffffffffff";
    const now = new Date().toISOString();
    useSessionStore.getState().addSession({
      id: sessionId,
      name: "Unrelated",
      workerIds: [],
      createdAt: now,
      updatedAt: now,
    });

    renderHook(() => useWorkerEvents());
    registered.get("worker_killed")?.({ payload: { workerId } });

    expect(mockSessionRemoveWorker).not.toHaveBeenCalled();
  });
});
