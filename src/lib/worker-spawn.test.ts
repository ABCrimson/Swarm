// ── Worker spawn: process options vs agent metadata split ───
//
// spawnWorkerFromSpec is the one place a full WorkerSpawnSpec gets
// split: process options (name/shell/cwd/env/repoRoot/isolation) go to
// Rust via
// spawnWorker; agent metadata (role/model/systemPrompt) is stored
// client-side in useWorkerAgentStore, keyed by the new worker id, and
// must never reach the IPC payload. This proves both halves of that
// split, plus the session_add_worker wiring for template application.

import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";
import { useSessionStore } from "#store/sessions";
import type { Session } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

const spawnWorkerMock = vi.fn();
const sessionAddWorkerMock = vi.fn();
const readConfigMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  spawnWorker: (...args: unknown[]) => spawnWorkerMock(...args),
  sessionAddWorker: (...args: unknown[]) => sessionAddWorkerMock(...args),
  readConfig: (...args: unknown[]) => readConfigMock(...args),
}));

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: crypto.randomUUID(),
    name: "test-session",
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStores(): void {
  for (const [id] of useWorkerStore.getState().workers) useWorkerStore.getState().removeWorker(id);
  for (const [id] of useSessionStore.getState().sessions)
    useSessionStore.getState().removeSession(id);
  for (const [id] of useWorkerAgentStore.getState().metadata) {
    useWorkerAgentStore.getState().removeAgentMetadata(id);
  }
}

describe("spawnWorkerFromSpec", () => {
  beforeEach(() => {
    resetStores();
    spawnWorkerMock.mockReset();
    sessionAddWorkerMock.mockReset();
    readConfigMock.mockReset();
    // Default: no persisted project root unless a test sets one.
    readConfigMock.mockResolvedValue(null);
  });
  afterEach(resetStores);

  it("sends only process options to spawnWorker — agent metadata never reaches the IPC payload", async () => {
    spawnWorkerMock.mockResolvedValueOnce("worker-1");

    await spawnWorkerFromSpec({
      name: "Agent",
      shell: "/bin/bash",
      role: "analyst",
      model: "sonnet",
      systemPrompt: "You are an analyst.",
    });

    expect(spawnWorkerMock).toHaveBeenCalledWith({ name: "Agent", shell: "/bin/bash" });
  });

  it("stores role/model/systemPrompt in the agent metadata store, keyed by the new worker id", async () => {
    spawnWorkerMock.mockResolvedValueOnce("worker-2");

    const workerId = await spawnWorkerFromSpec({
      name: "Agent",
      role: "coder",
      model: "opus",
      systemPrompt: "You write code.",
    });

    expect(workerId).toBe("worker-2");
    expect(useWorkerAgentStore.getState().metadata.get("worker-2")).toEqual({
      role: "coder",
      model: "opus",
      systemPrompt: "You write code.",
    });
  });

  it("does not create an agent metadata entry when the spec carries no agent fields", async () => {
    spawnWorkerMock.mockResolvedValueOnce("worker-plain");

    await spawnWorkerFromSpec({ name: "Plain Worker" });

    expect(useWorkerAgentStore.getState().metadata.has("worker-plain")).toBe(false);
  });

  it("keeps the record worker_spawned and worktree_created stored before spawn_worker returned", async () => {
    // The events can beat the command's response to the webview.
    spawnWorkerMock.mockImplementationOnce(async () => {
      useWorkerStore.getState().addWorker({
        id: "worker-early",
        state: "running",
        name: "Early",
        pid: 4242,
        startedAt: "2026-09-23T00:00:00.000Z",
      });
      useWorkerStore
        .getState()
        .setWorktreeInfo("worker-early", "/repo/.swarm/worktrees/w-early", "swarm/early-1");
      return "worker-early";
    });

    await spawnWorkerFromSpec({ name: "Early" });

    expect(useWorkerStore.getState().workers.get("worker-early")).toStrictEqual({
      id: "worker-early",
      state: "running",
      name: "Early",
      pid: 4242,
      startedAt: "2026-09-23T00:00:00.000Z",
      worktreePath: "/repo/.swarm/worktrees/w-early",
      branch: "swarm/early-1",
    });
  });

  it("adds a worker placeholder when the store does not hold the worker yet", async () => {
    spawnWorkerMock.mockResolvedValueOnce("worker-3");

    await spawnWorkerFromSpec({ name: "Placeholder" });

    const worker = useWorkerStore.getState().workers.get("worker-3");
    expect(worker?.name).toBe("Placeholder");
    expect(worker?.state).toBe("running");
  });

  it("registers the worker against the session and grows its workerIds when sessionId is given", async () => {
    const session = createSession();
    useSessionStore.getState().addSession(session);
    spawnWorkerMock.mockResolvedValueOnce("worker-4");
    sessionAddWorkerMock.mockResolvedValueOnce(undefined);

    await spawnWorkerFromSpec({ name: "Agent" }, session.id);

    expect(sessionAddWorkerMock).toHaveBeenCalledWith(session.id, "worker-4");
    expect(useSessionStore.getState().sessions.get(session.id)?.workerIds).toEqual(["worker-4"]);
  });

  it("skips session wiring silently when no sessionId is given", async () => {
    spawnWorkerMock.mockResolvedValueOnce("worker-no-session");

    await spawnWorkerFromSpec({ name: "Agent" });

    expect(sessionAddWorkerMock).not.toHaveBeenCalled();
  });

  it("still returns the worker id when session_add_worker fails", async () => {
    spawnWorkerMock.mockResolvedValueOnce("worker-5");
    sessionAddWorkerMock.mockRejectedValueOnce(new Error("boom"));
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const workerId = await spawnWorkerFromSpec({ name: "Agent" }, "missing-session");

    expect(workerId).toBe("worker-5");
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      'Worker "Agent" Spawned But Could Not Join The Session',
      { description: "boom" },
    );
  });

  it("returns null and skips all store writes when spawnWorker degrades to null (no Tauri IPC bridge)", async () => {
    spawnWorkerMock.mockResolvedValueOnce(null);

    const workerId = await spawnWorkerFromSpec(
      { name: "Agent", role: "coder", model: "opus", systemPrompt: "You write code." },
      "some-session",
    );

    expect(workerId).toBeNull();
    expect(useWorkerStore.getState().workers.size).toBe(0);
    expect(useWorkerAgentStore.getState().metadata.size).toBe(0);
    expect(sessionAddWorkerMock).not.toHaveBeenCalled();
  });

  // ── Persisted project root: template/session spawns keep worktree
  // isolation, so repoRoot falls back to the persisted default_repo_root
  // when the spec has no repoRoot of its own.

  it("falls back to the persisted default_repo_root when the spec has no repoRoot of its own", async () => {
    readConfigMock.mockResolvedValueOnce("C:/Projects/swarm-orchestrator");
    spawnWorkerMock.mockResolvedValueOnce("worker-6");

    await spawnWorkerFromSpec({ name: "Templated Agent" });

    expect(spawnWorkerMock).toHaveBeenCalledWith({
      name: "Templated Agent",
      repoRoot: "C:/Projects/swarm-orchestrator",
    });
  });

  it("prefers the spec's own repoRoot over the persisted default", async () => {
    readConfigMock.mockResolvedValueOnce("C:/Projects/persisted-default");
    spawnWorkerMock.mockResolvedValueOnce("worker-7");

    await spawnWorkerFromSpec({ name: "Explicit Agent", repoRoot: "C:/Projects/explicit" });

    expect(spawnWorkerMock).toHaveBeenCalledWith({
      name: "Explicit Agent",
      repoRoot: "C:/Projects/explicit",
    });
  });

  it("spawns unisolated (no repoRoot key) when there is no persisted default either", async () => {
    spawnWorkerMock.mockResolvedValueOnce("worker-8");

    await spawnWorkerFromSpec({ name: "Unisolated Agent" });

    const [payload] = spawnWorkerMock.mock.calls[0] as [Record<string, unknown>];
    expect(payload).not.toHaveProperty("repoRoot");
  });
});
