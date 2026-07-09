import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "#store/types";
import { useWorkerStore } from "#store/workers";

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
    // Reset the store to a clean state before each test
    const state = useWorkerStore.getState();
    for (const [id] of state.workers) {
      state.removeWorker(id);
    }
    state.selectWorker(null);
  });

  afterEach(() => {
    const state = useWorkerStore.getState();
    for (const [id] of state.workers) {
      state.removeWorker(id);
    }
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

    it("clears selectedId when the selected worker is removed", () => {
      const worker = createWorker();
      const { addWorker, selectWorker, removeWorker } = useWorkerStore.getState();
      addWorker(worker);
      selectWorker(worker.id);
      expect(useWorkerStore.getState().selectedId).toBe(worker.id);

      removeWorker(worker.id);

      expect(useWorkerStore.getState().selectedId).toBeNull();
    });

    it("does not clear selectedId when a different worker is removed", () => {
      const w1 = createWorker({ name: "w1" });
      const w2 = createWorker({ name: "w2" });
      const { addWorker, selectWorker, removeWorker } = useWorkerStore.getState();
      addWorker(w1);
      addWorker(w2);
      selectWorker(w1.id);

      removeWorker(w2.id);

      expect(useWorkerStore.getState().selectedId).toBe(w1.id);
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

    it("ring-buffers output at 10,000 characters", () => {
      const worker = createWorker();
      const { addWorker, appendOutput } = useWorkerStore.getState();
      addWorker(worker);

      // Write 12,000 characters
      const bigChunk = "x".repeat(12_000);
      appendOutput(worker.id, bigChunk);

      const output = useWorkerStore.getState().workers.get(worker.id)?.output;
      expect(output?.length).toBe(10_000);
    });

    it("preserves the most recent data when ring-buffering", () => {
      const worker = createWorker();
      const { addWorker, appendOutput } = useWorkerStore.getState();
      addWorker(worker);

      // Fill to near capacity
      appendOutput(worker.id, "a".repeat(9_990));
      // Append data that pushes past the 10k limit
      appendOutput(worker.id, "RECENT_DATA_END");

      const output = useWorkerStore.getState().workers.get(worker.id)?.output ?? "";
      expect(output.endsWith("RECENT_DATA_END")).toBe(true);
      expect(output.length).toBe(10_000);
    });

    it("does nothing for a non-existent worker", () => {
      const { appendOutput } = useWorkerStore.getState();
      // Should not throw
      appendOutput("non-existent", "data");
    });
  });

  describe("selectWorker", () => {
    it("selects a worker by id", () => {
      const worker = createWorker();
      const { addWorker, selectWorker } = useWorkerStore.getState();
      addWorker(worker);

      selectWorker(worker.id);

      expect(useWorkerStore.getState().selectedId).toBe(worker.id);
    });

    it("deselects when set to null", () => {
      const worker = createWorker();
      const { addWorker, selectWorker } = useWorkerStore.getState();
      addWorker(worker);
      selectWorker(worker.id);

      selectWorker(null);

      expect(useWorkerStore.getState().selectedId).toBeNull();
    });
  });
});
