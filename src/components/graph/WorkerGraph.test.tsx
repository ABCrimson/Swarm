// ── WorkerGraph — measured edges replace fabricated ones ─────────────
//
// DIRECTIVE-IMPLEMENTED: the empty-state acceptance test. Three
// hand-spawned workers with no measured causality must render as three
// nodes with ZERO edges and the quiet "No Measured Causality Yet" hint
// — never a fabricated "Spawn Order" chain (see the deleted
// SpawnOrderEdge.tsx). This file also proves the manual-acceptance
// parity case: worker A's AI spawning B + running a command yields
// exactly A->B spawn + A->B command, no chain edges.
//
// The interaction suite below covers the node context menu (its actions
// reach the backend), the derived node list (a departed worker's node
// goes with it), xyflow's delete keys (never a live worker), workflow
// import, and render isolation from PTY output.

// The node context menu is a native popover (see the shim's header).
import "./top-layer-shim";

import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkerType } from "@xyflow/react";
import { getDefaultStore } from "jotai";
import { Profiler } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reduceNodeUi, toFlowEdges, WorkerGraph } from "#components/graph/WorkerGraph";
import { MockElkWorker as MockWorker } from "#hooks/elk-worker-fake";
import type { DomainEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

// The worker lifecycle IPC the context menu must reach (via useWorker).
const ipc = vi.hoisted(() => ({
  pauseWorker: vi.fn(async (_id: string) => {}),
  resumeWorker: vi.fn(async (_id: string) => {}),
  killWorker: vi.fn(async (_id: string) => {}),
}));
vi.mock(import("#lib/tauri"), async (importOriginal) => ({ ...(await importOriginal()), ...ipc }));

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
  await waitFor(() => {
    expect(screen.queryByText("Computing Layout")).not.toBeInTheDocument();
  });
}

describe("WorkerGraph — measured edges", () => {
  beforeEach(() => {
    MockWorker.reset(true);
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

  it("DIRECTIVE-IMPLEMENTED: a file_written ingest with NO topology change updates the rendered 'Wrote N Files' badge live, without waiting on a relayout", async () => {
    const workerA = createWorker({ id: "w-a", name: "Worker A" });
    act(() => {
      useWorkerStore.getState().addWorker(workerA);
    });

    render(<WorkerGraph />);
    await waitForLayoutSettled();

    // No file has been written yet -- no badge.
    expect(screen.queryByText(/Wrote \d+ Files?/)).not.toBeInTheDocument();

    // Ingest a file_written event for the SAME worker set (no worker
    // added/removed, no edge added/removed) -- the topology fingerprint
    // useElkLayout keys off (node ids + edge source->target pairs) is
    // unchanged, so this must never trigger a relayout, yet the badge
    // must still update: it's read fresh from the provenance store every
    // render by the node itself (WorkerNode's own store subscription), not
    // baked into the ELK-round-tripped node data.
    act(() => {
      useProvenanceStore.getState().ingestEvent(
        ev({
          seq: 20,
          type: "file_written",
          originWorker: "w-a",
          payload: { path: "/repo/out.txt", bytes: 7 },
        }),
      );
    });

    expect(await screen.findByText("Wrote 1 File")).toBeInTheDocument();
    // The layout overlay never reappeared -- proves no relayout fired.
    expect(screen.queryByText("Computing Layout")).not.toBeInTheDocument();
  });
});

/** The xyflow node wrapper for a worker id (focusable, carries the accessible name). */
function nodeFor(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!node) throw new Error(`no node rendered for ${id}`);
  return node;
}

describe("WorkerGraph — interactions", () => {
  beforeEach(() => {
    MockWorker.reset(true);
    vi.stubGlobal("Worker", MockWorker);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    resetStores();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderWith(...workers: Worker[]): Promise<void> {
    act(() => {
      for (const worker of workers) useWorkerStore.getState().addWorker(worker);
    });
    render(<WorkerGraph />);
    await waitForLayoutSettled();
  }

  it("context-menu Kill reaches the kill IPC and drops the node only once the backend confirms", async () => {
    const user = userEvent.setup();
    const { promise, resolve } = Promise.withResolvers<void>();
    ipc.killWorker.mockReturnValueOnce(promise);
    await renderWith(
      createWorker({ id: "w-a", name: "Alpha" }),
      createWorker({ id: "w-b", name: "Beta" }),
    );

    fireEvent.contextMenu(nodeFor("w-a"));
    await user.click(screen.getByRole("menuitem", { name: "Kill" }));

    expect(ipc.killWorker).toHaveBeenCalledWith("w-a");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(useWorkerStore.getState().workers.has("w-a")).toBe(true); // still in flight
    await act(async () => resolve());
    expect(useWorkerStore.getState().workers.has("w-a")).toBe(false);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("context-menu Pause reaches the pause IPC; Resume is unavailable for a running worker", async () => {
    const user = userEvent.setup();
    await renderWith(createWorker({ id: "w-a", name: "Alpha", state: "running" }));

    fireEvent.contextMenu(nodeFor("w-a"));
    expect(screen.getByRole("menuitem", { name: "Resume" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("menuitem", { name: "Pause" }));

    expect(ipc.pauseWorker).toHaveBeenCalledWith("w-a");
    await waitFor(() => expect(useWorkerStore.getState().workers.get("w-a")?.state).toBe("paused"));
  });

  it("the menu is labelled by its worker, takes focus, and closes on Escape", async () => {
    const user = userEvent.setup();
    await renderWith(createWorker({ id: "w-a", name: "Alpha" }));

    fireEvent.contextMenu(nodeFor("w-a"));

    expect(screen.getByRole("menu", { name: "Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pause" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Kill" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("right-clicking a second node retargets the open menu instead of closing it", async () => {
    await renderWith(
      createWorker({ id: "w-a", name: "Alpha" }),
      createWorker({ id: "w-b", name: "Beta" }),
    );

    fireEvent.contextMenu(nodeFor("w-a"));
    fireEvent.pointerDown(nodeFor("w-b"));
    fireEvent.contextMenu(nodeFor("w-b"));

    expect(screen.getByRole("menu", { name: "Beta" })).toBeInTheDocument();
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("removing the last worker removes its node and shows the empty state (no ghost node)", async () => {
    await renderWith(createWorker({ id: "w-a", name: "Alpha" }));

    act(() => useWorkerStore.getState().removeWorker("w-a"));

    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(await screen.findByText(/No Workers Running/)).toBeInTheDocument();
  });

  it("Backspace/Delete never remove a selected live worker's node", async () => {
    const user = userEvent.setup();
    await renderWith(
      createWorker({ id: "w-a", name: "Alpha" }),
      createWorker({ id: "w-b", name: "Beta" }),
    );

    // fireEvent: user-event's mousedown reaches d3-drag with no view under jsdom.
    fireEvent.click(nodeFor("w-a"));
    expect(nodeFor("w-a")).toHaveClass("selected");
    await user.keyboard("{Backspace}{Delete}");

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(useWorkerStore.getState().workers.has("w-a")).toBe(true);
  });

  it("gives each node wrapper an accessible name and opens the detail panel on Enter", async () => {
    const user = userEvent.setup();
    await renderWith(createWorker({ id: "w-a", name: "Alpha", pid: 42 }));

    const node = nodeFor("w-a");
    // (jsdom never measures nodes, so xyflow keeps the wrapper visibility:
    // hidden and computes no accessible name; assert the attribute.)
    expect(node).toHaveAttribute("aria-label", "Worker Alpha, Status: Running, PID 42");
    // The wrapper is the one tab stop: nothing inside the node is focusable.
    expect(node.querySelectorAll("[tabindex]")).toHaveLength(0);
    node.focus();
    await user.keyboard("{Enter}");
    // Selection landed in the ui atoms — the Workers page renders the panel.
    expect(getDefaultStore().get(selectedWorkerIdAtom)).toBe("w-a");
    expect(getDefaultStore().get(detailPanelOpenAtom)).toBe(true);
  });

  it("a PTY output chunk re-renders nothing in the graph", async () => {
    const commits = vi.fn();
    act(() => useWorkerStore.getState().addWorker(createWorker({ id: "w-a", name: "Alpha" })));
    render(
      <Profiler id="graph" onRender={commits}>
        <WorkerGraph />
      </Profiler>,
    );
    await waitForLayoutSettled();
    commits.mockClear();

    act(() => {
      for (let i = 0; i < 5; i++) useWorkerStore.getState().appendOutput("w-a", `chunk ${i}\n`);
    });

    expect(commits).not.toHaveBeenCalled();
  });

  it("imports a workflow onto live workers only: positions and annotations, nothing fabricated", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("isTauri", true);
    vi.mocked(open).mockResolvedValueOnce("/tmp/wf.json");
    vi.mocked(readTextFile).mockResolvedValueOnce(
      JSON.stringify({
        id: "wf",
        name: "Saved",
        nodes: [
          { id: "w-a", type: "worker", position: { x: 5, y: 5 }, data: {} },
          { id: "w-gone", type: "worker", position: { x: 9, y: 9 }, data: {} },
        ],
        edges: [
          { id: "m-1", source: "w-a", target: "w-b" },
          { id: "m-2", source: "w-a", target: "w-gone" },
        ],
      }),
    );
    await renderWith(
      createWorker({ id: "w-a", name: "Alpha" }),
      createWorker({ id: "w-b", name: "Beta" }),
    );

    await user.click(screen.getByRole("button", { name: "Import Workflow" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Workflow Imported", {
        description: "Placed 1 Of 2 Nodes, Added 1 Annotations",
      }),
    );
    expect(screen.queryByText("w-gone")).not.toBeInTheDocument();
    // The imported annotation renders as the manual kind, in its own legend group.
    expect(screen.getByText("Annotation")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
  });
});

describe("toFlowEdges", () => {
  it("builds non-deletable measured edges with an arrowhead and a worker-named accessible label", () => {
    const [edge] = toFlowEdges(
      [{ from: "w-a", to: "w-b", kind: "spawn", count: 3, lastSeq: 9 } as never],
      { "w-a": "Alpha", "w-b": "Beta" },
    );

    expect(edge).toMatchObject({
      id: "prov-w-a-w-b-spawn",
      deletable: false,
      markerEnd: { type: MarkerType.ArrowClosed },
      ariaLabel: "Spawn: Alpha To Beta (×3)",
      data: { kind: "spawn", count: 3, lastSeq: 9 },
    });
  });
});

describe("reduceNodeUi", () => {
  it("keeps a dragged position, measured size and selection per node", () => {
    const ui = reduceNodeUi(new Map(), [
      { type: "position", id: "a", position: { x: 1, y: 2 }, dragging: true },
      { type: "dimensions", id: "a", dimensions: { width: 220, height: 100 } },
      { type: "select", id: "a", selected: true },
    ]);

    expect(ui.get("a")).toEqual({
      position: { x: 1, y: 2 },
      dragging: true,
      measured: { width: 220, height: 100 },
      selected: true,
    });
  });

  it("a drag end without a position keeps the last one", () => {
    const start = reduceNodeUi(new Map(), [
      { type: "position", id: "a", position: { x: 1, y: 2 } },
    ]);

    const ended = reduceNodeUi(start, [{ type: "position", id: "a", dragging: false }]);

    expect(ended.get("a")?.position).toEqual({ x: 1, y: 2 });
  });
});
