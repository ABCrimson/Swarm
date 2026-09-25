import { beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "#store/types";
import { OUTPUT_BUFFER_CHARS, useWorkerStore } from "#store/workers";

function createWorker(overrides?: Partial<Worker>): Worker {
  return {
    id: crypto.randomUUID(),
    state: "idle",
    name: "test-worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("WorkerStore", () => {
  beforeEach(() => {
    useWorkerStore.setState({ workers: new Map() });
  });

  describe("addWorker", () => {
    it("adds a worker to the store", () => {
      const worker = createWorker({ name: "alpha" });
      useWorkerStore.getState().addWorker(worker);

      const stored = useWorkerStore.getState().workers.get(worker.id);
      expect(stored).toBeDefined();
      expect(stored?.name).toBe("alpha");
      expect(stored?.state).toBe("idle");
    });

    it("adds multiple workers", () => {
      const w1 = createWorker({ name: "w1" });
      const w2 = createWorker({ name: "w2" });

      const { addWorker } = useWorkerStore.getState();
      addWorker(w1);
      addWorker(w2);

      expect(useWorkerStore.getState().workers.size).toBe(2);
    });
  });

  describe("removeWorker", () => {
    it("removes an existing worker", () => {
      const worker = createWorker();
      const { addWorker, removeWorker } = useWorkerStore.getState();
      addWorker(worker);

      removeWorker(worker.id);

      expect(useWorkerStore.getState().workers.has(worker.id)).toBe(false);
    });
  });

  describe("addMissingWorkers", () => {
    it("adds listed workers the store does not know", () => {
      const w1 = createWorker({ name: "w1" });
      const w2 = createWorker({ name: "w2" });

      useWorkerStore.getState().addMissingWorkers([w1, w2]);

      expect([...useWorkerStore.getState().workers.values()]).toStrictEqual([w1, w2]);
    });

    it("keeps a worker that live events already put in the store", () => {
      const live = createWorker({ state: "paused", output: "hello" });
      useWorkerStore.getState().addWorker(live);

      useWorkerStore
        .getState()
        .addMissingWorkers([{ ...live, state: "running", output: undefined }]);

      expect(useWorkerStore.getState().workers.get(live.id)).toStrictEqual(live);
    });
  });

  describe("updateState", () => {
    it("updates a worker state to running", () => {
      const worker = createWorker({ state: "idle" });
      const { addWorker, updateState } = useWorkerStore.getState();
      addWorker(worker);

      updateState(worker.id, "running");

      expect(useWorkerStore.getState().workers.get(worker.id)?.state).toBe("running");
    });

    it("updates a worker state to paused", () => {
      const worker = createWorker({ state: "running" });
      const { addWorker, updateState } = useWorkerStore.getState();
      addWorker(worker);

      updateState(worker.id, "paused");

      expect(useWorkerStore.getState().workers.get(worker.id)?.state).toBe("paused");
    });

    it("updates a worker state to error", () => {
      const worker = createWorker({ state: "running" });
      const { addWorker, updateState } = useWorkerStore.getState();
      addWorker(worker);

      updateState(worker.id, "error");

      expect(useWorkerStore.getState().workers.get(worker.id)?.state).toBe("error");
    });

    it("does nothing for a non-existent worker id", () => {
      const { updateState } = useWorkerStore.getState();
      // Should not throw
      updateState("non-existent-id", "running");
      expect(useWorkerStore.getState().workers.size).toBe(0);
    });
  });

  describe("appendOutput (ring buffer)", () => {
    it("appends output to a worker", () => {
      const worker = createWorker();
      const { addWorker, appendOutput } = useWorkerStore.getState();
      addWorker(worker);

      appendOutput(worker.id, "hello ");
      appendOutput(worker.id, "world");

      expect(useWorkerStore.getState().workers.get(worker.id)?.output).toBe("hello world");
    });

    it("ring-buffers output to OUTPUT_BUFFER_CHARS characters", () => {
      const worker = createWorker();
      const { addWorker, appendOutput } = useWorkerStore.getState();
      addWorker(worker);

      appendOutput(worker.id, "x".repeat(OUTPUT_BUFFER_CHARS + 2_000));

      const output = useWorkerStore.getState().workers.get(worker.id)?.output;
      expect(output?.length).toBe(OUTPUT_BUFFER_CHARS);
    });

    it("preserves the most recent data when ring-buffering", () => {
      const worker = createWorker();
      const { addWorker, appendOutput } = useWorkerStore.getState();
      addWorker(worker);

      // Fill to near capacity
      appendOutput(worker.id, "a".repeat(OUTPUT_BUFFER_CHARS - 10));
      // Append data that pushes past the limit
      appendOutput(worker.id, "RECENT_DATA_END");

      const output = useWorkerStore.getState().workers.get(worker.id)?.output ?? "";
      expect(output.endsWith("RECENT_DATA_END")).toBe(true);
      expect(output.length).toBe(OUTPUT_BUFFER_CHARS);
    });

    it("does nothing for a non-existent worker", () => {
      useWorkerStore.getState().appendOutput("non-existent", "data");

      expect(useWorkerStore.getState().workers.size).toBe(0);
    });
  });

  describe("setWorktreeInfo", () => {
    it("sets worktreePath and branch on an existing worker", () => {
      const worker = createWorker();
      const { addWorker, setWorktreeInfo } = useWorkerStore.getState();
      addWorker(worker);

      setWorktreeInfo(
        worker.id,
        "/home/user/.swarm/worktrees/repo-abcd1234/w-11112222",
        "swarm/agent-11112222",
      );

      const stored = useWorkerStore.getState().workers.get(worker.id);
      expect(stored?.worktreePath).toBe("/home/user/.swarm/worktrees/repo-abcd1234/w-11112222");
      expect(stored?.branch).toBe("swarm/agent-11112222");
    });

    it("does nothing for a non-existent worker id", () => {
      const { setWorktreeInfo } = useWorkerStore.getState();
      expect(() => setWorktreeInfo("non-existent", "/wt", "swarm/x-1")).not.toThrow();
    });

    it("leaves worktreePath/branch undefined for a worker spawned without isolation", () => {
      const worker = createWorker();
      useWorkerStore.getState().addWorker(worker);

      const stored = useWorkerStore.getState().workers.get(worker.id);
      expect(stored?.worktreePath).toBeUndefined();
      expect(stored?.branch).toBeUndefined();
    });
  });
});
