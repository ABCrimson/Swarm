import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportAsJSON, exportAsMarkdown, exportMetricsCSV } from "#lib/export";
import { useMessageHistoryStore } from "#store/message-history";
import type { MetricPoint, Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

function createSession(overrides?: Partial<Session>): Session {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "test-session",
    workerIds: [],
    createdAt: "2026-01-15T10:30:00.000Z",
    updatedAt: "2026-01-15T12:00:00.000Z",
    ...overrides,
  };
}

function resetStores(): void {
  const workerState = useWorkerStore.getState();
  for (const [id] of workerState.workers) {
    workerState.removeWorker(id);
  }
  useMessageHistoryStore.getState().clearAll();
}

describe("exportAsMarkdown", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("includes the session name as a heading", () => {
    const session = createSession({ name: "My Session" });
    const md = exportAsMarkdown(session);

    expect(md).toContain("# Session: My Session");
  });

  it("includes session ID and timestamps", () => {
    const session = createSession();
    const md = exportAsMarkdown(session);

    expect(md).toContain(session.id);
    expect(md).toContain("**Created:**");
    expect(md).toContain("**Updated:**");
  });

  it("includes worker count", () => {
    const session = createSession({ workerIds: ["w1", "w2"] });
    const md = exportAsMarkdown(session);

    expect(md).toContain("**Workers:** 2");
  });

  it("includes metadata description and tags when present", () => {
    const session = createSession({
      metadata: {
        description: "A test description",
        tags: ["alpha", "beta"],
      },
    });
    const md = exportAsMarkdown(session);

    expect(md).toContain("**Description:** A test description");
    expect(md).toContain("**Tags:** alpha, beta");
  });

  it("includes configuration block when present", () => {
    const session = createSession({ config: { maxWorkers: 5 } });
    const md = exportAsMarkdown(session);

    expect(md).toContain("## Configuration");
    expect(md).toContain('"maxWorkers": 5');
  });

  it("renders worker details when workers exist in the store", () => {
    const workerId = "11111111-2222-3333-4444-555555555555";
    useWorkerStore.getState().addWorker({
      id: workerId,
      state: "running",
      name: "worker-alpha",
      startedAt: "2026-01-15T10:30:00.000Z",
    });

    const session = createSession({ workerIds: [workerId] });
    const md = exportAsMarkdown(session);

    expect(md).toContain("### worker-alpha");
    expect(md).toContain("**State:** running");
  });

  it("handles workers not found in the store gracefully", () => {
    const session = createSession({ workerIds: ["00000000-0000-0000-0000-000000000000"] });
    const md = exportAsMarkdown(session);

    expect(md).toContain("Worker data not available");
  });
});

describe("exportAsJSON", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("returns valid JSON with session and workers keys", () => {
    const session = createSession();
    const json = exportAsJSON(session);
    const parsed = JSON.parse(json);

    expect(parsed.session).toBeDefined();
    expect(parsed.workers).toBeDefined();
    expect(parsed.exportedAt).toBeDefined();
  });

  it("includes session data in the output", () => {
    const session = createSession({ name: "export-test" });
    const json = exportAsJSON(session);
    const parsed = JSON.parse(json);

    expect(parsed.session.name).toBe("export-test");
    expect(parsed.session.id).toBe(session.id);
  });

  it("includes worker data when available", () => {
    const workerId = "11111111-2222-3333-4444-555555555555";
    useWorkerStore.getState().addWorker({
      id: workerId,
      state: "idle",
      name: "w1",
      startedAt: "2026-01-15T10:30:00.000Z",
    });

    const session = createSession({ workerIds: [workerId] });
    const json = exportAsJSON(session);
    const parsed = JSON.parse(json);

    expect(parsed.workers[workerId].worker.name).toBe("w1");
  });

  it("sets worker to null when not found in the store", () => {
    const session = createSession({ workerIds: ["missing-id-1234-5678-abcdef012345"] });
    const json = exportAsJSON(session);
    const parsed = JSON.parse(json);

    expect(parsed.workers["missing-id-1234-5678-abcdef012345"].worker).toBeNull();
  });

  it("outputs exportedAt as an ISO timestamp", () => {
    const session = createSession();
    const json = exportAsJSON(session);
    const parsed = JSON.parse(json);

    // Verify it parses as a valid date
    const date = new Date(parsed.exportedAt);
    expect(date.getTime()).not.toBeNaN();
  });
});

describe("exportMetricsCSV", () => {
  it("produces CSV with header row", () => {
    const csv = exportMetricsCSV([]);
    expect(csv).toBe("time,cpu,memory,workerCount");
  });

  it("produces CSV with data rows", () => {
    const metrics: MetricPoint[] = [
      { time: 1000, cpu: 50, memory: 60, workerCount: 3 },
      { time: 2000, cpu: 70, memory: 80, workerCount: 5 },
    ];

    const csv = exportMetricsCSV(metrics);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("time,cpu,memory,workerCount");
    expect(lines[1]).toBe("1000,50,60,3");
    expect(lines[2]).toBe("2000,70,80,5");
  });

  it("handles a single data point", () => {
    const metrics: MetricPoint[] = [{ time: 500, cpu: 25, memory: 30, workerCount: 1 }];
    const csv = exportMetricsCSV(metrics);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(2);
  });
});
