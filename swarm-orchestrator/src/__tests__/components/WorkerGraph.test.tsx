// ── WorkerGraph — measured edges replace fabricated ones ─────────────
//
// DIRECTIVE-IMPLEMENTED: the empty-state acceptance test. Three
// hand-spawned workers with no measured causality must render as three
// nodes with ZERO edges and the quiet "No Measured Causality Yet" hint
// — never a fabricated "Spawn Order" chain (see the deleted
// SpawnOrderEdge.tsx). This file also proves the manual-acceptance
// parity case: worker A's AI spawning B + running a command yields
// exactly A->B spawn + A->B command, no chain edges.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerGraph } from "#components/graph/WorkerGraph";
import type { DomainEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { useWorkerStore } from "#store/workers";

/**
 * Minimal mock of the DOM `Worker` API — same shape as
 * `useElkLayout.test.tsx`'s `MockWorker` (jsdom has no real Worker/module
 * worker support). `autoRespondLayout` speaks enough of elkjs's own
 * `{cmd, id}` protocol to resolve `elk.layout()` so `isLayouting` settles
 * to `false` and this file can assert on the settled DOM.
 */
class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  postMessage = vi.fn(
    (msg: { id: number; cmd?: string; graph?: { children?: { id: string }[] } }) => {
      if (msg.cmd !== "layout") return;
      const children = (msg.graph?.children ?? []).map((child, i) => ({
        id: child.id,
        x: (i + 1) * 100,
        y: (i + 1) * 50,
      }));
      this.onmessage?.({ data: { id: msg.id, data: { id: "root", children } } } as MessageEvent);
    },
  );
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }
}

/**
 * jsdom has no layout engine, so a real `ResizeObserver` never fires and
 * `DOMMatrixReadOnly` (which XYFlow's own node-measurement path reaches
 * for once a resize entry arrives) doesn't exist either — feeding XYFlow
 * a synthetic resize entry to get past a no-op observer trades one
 * missing-API error for the next one. A no-op mock (matching this
 * codebase's established practice — see `ParticleBackground.test.tsx`'s
 * documented decision to stop short of the same wall) means XYFlow never
 * considers a node "measured" and never paints an edge `<path>` at all —
 * so this file asserts on OUR OWN render-time computations (the legend's
 * kind rows, the empty-causality hint, the provenance store's edge
 * count) rather than XYFlow's internal `.react-flow__edge` DOM output,
 * which would be vacuously zero here regardless of what WorkerGraph
 * computed.
 */
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function createWorker(overrides?: Partial<Worker>): Worker {
  return {
    id: crypto.randomUUID(),
    state: "running",
    name: "Worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function ev(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, "seq" | "type" | "payload">,
): DomainEvent {
  return { ts: overrides.seq * 1000, ...overrides };
}

function resetStores(): void {
  act(() => {
    for (const [id] of useWorkerStore.getState().workers) {
      useWorkerStore.getState().removeWorker(id);
    }
    useProvenanceStore.getState().reset();
  });
}

/** Waits for the ELK layout overlay to clear (the mocked worker has responded and state committed). */
async function waitForLayoutSettled(): Promise<void> {
  await vi.waitFor(() => {
    expect(screen.queryByText("Computing Layout")).not.toBeInTheDocument();
  });
}

describe("WorkerGraph — measured edges", () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal("Worker", MockWorker);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    resetStores();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("DIRECTIVE-IMPLEMENTED: three hand-spawned workers with no measured causality render as three nodes, ZERO edges, and the quiet empty-causality hint — never a fabricated chain", async () => {
    act(() => {
      useWorkerStore.getState().addWorker(createWorker({ name: "Alpha" }));
      useWorkerStore.getState().addWorker(createWorker({ name: "Beta" }));
      useWorkerStore.getState().addWorker(createWorker({ name: "Gamma" }));
    });
    // provenance store is empty -- nothing measured has happened.

    render(<WorkerGraph />);
    await waitForLayoutSettled();

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();

    expect(screen.getByText("No Measured Causality Yet")).toBeInTheDocument();

    // The legend must be entirely absent too -- a row for a kind with
    // zero edges would describe a line style nothing on screen uses.
    for (const label of ["Spawn", "Kill", "Command", "Message", "Manual"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("MANUAL-ACCEPTANCE PARITY (1): worker A's AI spawning B + running a command yields exactly A->B spawn + A->B command, no chain edges", async () => {
    const workerA = createWorker({ id: "w-a", name: "Worker A" });
    const workerB = createWorker({ id: "w-b", name: "Worker B" });
    act(() => {
      useWorkerStore.getState().addWorker(workerA);
      useWorkerStore.getState().addWorker(workerB);
      // A's turn spawns B, stamped originWorker: A -- the causer differs
      // from the payload's own subject (B), which IS the edge.
      useProvenanceStore.getState().ingestEvent(
        ev({
          seq: 10,
          type: "worker_spawned",
          originWorker: "w-a",
          causeSeq: 1,
          payload: { workerId: "w-b", name: "Worker B", pid: 1 },
        }),
      );
      // The same turn then runs a command in B's PTY.
      useProvenanceStore.getState().ingestEvent(
        ev({
          seq: 11,
          type: "worker_input",
          originWorker: "w-a",
          causeSeq: 1,
          payload: { workerId: "w-b", bytes: 11, source: "tool", preview: "pnpm build\n" },
        }),
      );
    });

    render(<WorkerGraph />);
    await waitForLayoutSettled();

    // Exactly these two kinds render (the legend gates on presence) --
    // never a synthesized A->B->... chain. Cardinality itself (exactly
    // one record per kind, no duplicate/merged entries) is pinned down
    // at the store level in provenance.test.ts's collapse/count suite.
    expect(screen.getByText("Spawn")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.queryByText("Kill")).not.toBeInTheDocument();
    expect(screen.queryByText("Message")).not.toBeInTheDocument();
    expect(screen.queryByText("Manual")).not.toBeInTheDocument();
    expect(screen.queryByText("No Measured Causality Yet")).not.toBeInTheDocument();
  });

  it("drops an edge whose endpoint left the worker store (endpoint-drop), without deleting it from the provenance store", async () => {
    const workerA = createWorker({ id: "w-a", name: "Worker A" });
    act(() => {
      useWorkerStore.getState().addWorker(workerA);
      // w-b was spawned and later killed; the worker store no longer has
      // it, but the store's own edge record is never deleted (still
      // findable via the inspector).
      useProvenanceStore.getState().ingestEvent(
        ev({
          seq: 5,
          type: "worker_spawned",
          originWorker: "w-a",
          payload: { workerId: "w-b", name: "Departed", pid: 1 },
        }),
      );
    });

    render(<WorkerGraph />);
    await waitForLayoutSettled();

    // The departed worker's edge draws no legend row (nothing visible
    // renders it)...
    expect(screen.queryByText("Spawn")).not.toBeInTheDocument();
    expect(screen.getByText("No Measured Causality Yet")).toBeInTheDocument();
    // ...but the record itself is never deleted from the store, only
    // filtered out of what's shown -- still findable via the inspector.
    expect(useProvenanceStore.getState().edges.size).toBe(1);
  });
});
