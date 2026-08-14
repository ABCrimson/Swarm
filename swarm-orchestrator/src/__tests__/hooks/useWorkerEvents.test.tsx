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

function resetStores(): void {
  for (const [id] of useWorkerStore.getState().workers) useWorkerStore.getState().removeWorker(id);
  for (const [id] of useWorkerAgentStore.getState().metadata) {
    useWorkerAgentStore.getState().removeAgentMetadata(id);
  }
}

describe("useWorkerEvents", () => {
  beforeEach(() => {
    resetStores();
    registered.clear();
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
});
