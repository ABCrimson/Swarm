// ── Template application (Phase 0, Task 2) ───────────
//
// Previously, selecting a template on the Sessions page just showed a
// toast — no session was created and no worker was ever spawned, so a
// template's role/model/systemPrompt were entirely decorative.
// applyTemplate is the real implementation: it creates a session, spawns
// one worker per workerConfigs entry, and wires each into the session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTemplate, BUILT_IN_TEMPLATES } from "#lib/templates";
import { useSessionStore } from "#store/sessions";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

const createSessionMock = vi.fn();
const spawnWorkerMock = vi.fn();
const sessionAddWorkerMock = vi.fn();

vi.mock("#lib/tauri", () => ({
  createSession: (...args: unknown[]) => createSessionMock(...args),
  spawnWorker: (...args: unknown[]) => spawnWorkerMock(...args),
  sessionAddWorker: (...args: unknown[]) => sessionAddWorkerMock(...args),
}));

function mockSession(id: string, name: string) {
  return {
    id,
    name,
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

describe("applyTemplate", () => {
  beforeEach(() => {
    resetStores();
    createSessionMock.mockReset();
    spawnWorkerMock.mockReset();
    sessionAddWorkerMock.mockReset();
    sessionAddWorkerMock.mockResolvedValue(undefined);
  });
  afterEach(resetStores);

  it("creates a session and spawns one worker per workerConfigs entry", async () => {
    const template = BUILT_IN_TEMPLATES[1]; // Multi-Agent Parallel: 3 workers
    createSessionMock.mockResolvedValueOnce(mockSession("session-x", template.name));
    spawnWorkerMock
      .mockResolvedValueOnce("w1")
      .mockResolvedValueOnce("w2")
      .mockResolvedValueOnce("w3");

    const { session, workerIds } = await applyTemplate(template);

    expect(session.id).toBe("session-x");
    expect(workerIds).toEqual(["w1", "w2", "w3"]);
    expect(spawnWorkerMock).toHaveBeenCalledTimes(3);
  });

  it("does not add the session to the store itself — useSessionEvents' session_created handler owns that", async () => {
    const template = BUILT_IN_TEMPLATES[0];
    createSessionMock.mockResolvedValueOnce(mockSession("session-store", template.name));
    spawnWorkerMock.mockResolvedValueOnce("w-single");

    await applyTemplate(template);

    // A second, redundant addSession() here would race the event-driven
    // one instead of adding anything new — see #lib/worker-spawn's
    // session-wiring test below for the case where the event *has*
    // already populated the store by the time a worker spawns into it.
    expect(useSessionStore.getState().sessions.has("session-store")).toBe(false);
  });

  it("stores each spawned worker's role/model/systemPrompt in the agent metadata store", async () => {
    const template = BUILT_IN_TEMPLATES[0]; // Single Agent
    createSessionMock.mockResolvedValueOnce(mockSession("session-y", template.name));
    spawnWorkerMock.mockResolvedValueOnce("w-single");

    await applyTemplate(template);

    expect(useWorkerAgentStore.getState().metadata.get("w-single")).toEqual({
      role: "general",
      model: "sonnet",
      systemPrompt: "You are a helpful AI assistant.",
    });
  });

  it("registers each spawned worker against the new session, growing workerIds", async () => {
    const template = BUILT_IN_TEMPLATES[0];
    const session = mockSession("session-z", template.name);
    createSessionMock.mockResolvedValueOnce(session);
    // Simulate useSessionEvents having already added the session from
    // its session_created event — applyTemplate itself no longer does
    // this (see the test above), but spawnWorkerFromSpec's own
    // session-workerIds update still needs the session to exist in the
    // store to have anything to grow.
    useSessionStore.getState().addSession(session);
    spawnWorkerMock.mockResolvedValueOnce("w-solo");

    await applyTemplate(template);

    expect(sessionAddWorkerMock).toHaveBeenCalledWith("session-z", "w-solo");
    expect(useSessionStore.getState().sessions.get("session-z")?.workerIds).toEqual(["w-solo"]);
  });

  it("skips a worker whose spawn fails but still applies the rest of the template", async () => {
    const template = BUILT_IN_TEMPLATES[1]; // 3 workers
    createSessionMock.mockResolvedValueOnce(mockSession("session-partial", template.name));
    spawnWorkerMock
      .mockResolvedValueOnce("w1")
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce("w3");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { workerIds } = await applyTemplate(template);

    expect(workerIds).toEqual(["w1", "w3"]);
    consoleError.mockRestore();
  });

  it("counts a null spawn result (no Tauri bridge) as a failure without stopping the rest of the template", async () => {
    const template = BUILT_IN_TEMPLATES[1]; // 3 workers
    createSessionMock.mockResolvedValueOnce(mockSession("session-null", template.name));
    spawnWorkerMock
      .mockResolvedValueOnce("w1")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("w3");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { workerIds } = await applyTemplate(template);

    expect(workerIds).toEqual(["w1", "w3"]);
    consoleError.mockRestore();
  });
});
