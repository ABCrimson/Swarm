import { beforeEach, describe, expect, it } from "vitest";
import { useAgentSessionStore } from "#store/agent-sessions";
import { useSessionStore } from "#store/sessions";
import type { Worker } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

/**
 * immer 11.1.21 throws when a revoked Map/Set draft is read. The four
 * `enableMapSet` stores must therefore never leak a draft out of a producer:
 * a snapshot taken before an update has to stay fully readable (and
 * unchanged) after later updates, and values read back must be plain data.
 */

const delta = (seq: number, text: string) =>
  ({
    type: "agent_turn_delta",
    seq,
    payload: { workerId: "w1", turnId: "t1", blockIndex: 0, kind: "text", text },
  }) as const;

describe("Map-backed stores keep immer drafts inside their producers", () => {
  beforeEach(() => {
    useWorkerStore.setState({ workers: new Map() });
    useSessionStore.setState({ sessions: new Map(), activeSessionId: null });
    useWorkerAgentStore.setState({ metadata: new Map() });
    useAgentSessionStore.setState({ sessions: new Map(), transcripts: new Map() });
  });

  it("worker snapshots survive later updates", () => {
    const worker: Worker = { id: "a", state: "idle", name: "a", startedAt: "2026-10-10T00:00:00Z" };
    useWorkerStore.getState().addWorker(worker);
    const before = useWorkerStore.getState().workers;

    useWorkerStore.getState().updateState("a", "running");
    useWorkerStore.getState().appendOutput("a", "hi");
    useWorkerStore.getState().removeWorker("a");

    expect(before.get("a")?.state).toBe("idle");
    expect([...before.keys()]).toStrictEqual(["a"]);
    expect(useWorkerStore.getState().workers.size).toBe(0);
  });

  it("session snapshots survive later updates", () => {
    const store = useSessionStore.getState();
    store.addSession({ id: "s", name: "s", workerIds: [] } as never);
    const before = useSessionStore.getState().sessions;

    store.addWorkerToSession("s", "w");
    store.removeSession("s");

    expect(before.get("s")?.workerIds).toStrictEqual([]);
    expect(useSessionStore.getState().sessions.size).toBe(0);
  });

  it("agent metadata snapshots survive later updates", () => {
    useWorkerAgentStore.getState().setAgentMetadata("w", { provider: "claude" } as never);
    const before = useWorkerAgentStore.getState().metadata;

    useWorkerAgentStore.getState().removeAgentMetadata("w");

    expect(before.get("w")).toStrictEqual({ provider: "claude" });
    expect(useWorkerAgentStore.getState().metadata.size).toBe(0);
  });

  it("transcript streaming and turn maps stay readable across events", () => {
    const store = useAgentSessionStore.getState();
    store.addUserTurn("w1", "b1", "hello");
    store.applyEvent(delta(1, "a"));
    const before = useAgentSessionStore.getState().transcripts.get("w1");

    store.applyEvent(delta(2, "b"));
    store.removeSession("w1");

    expect(before?.streaming.get("t1:0")?.text).toBe("a");
    expect(before?.turnBubbles.get("t1")).toBe("b1");
    expect(useAgentSessionStore.getState().transcripts.has("w1")).toBe(false);
  });
});
