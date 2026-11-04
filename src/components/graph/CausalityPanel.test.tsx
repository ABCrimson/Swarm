// The native <dialog> needs jsdom stand-ins (see the shim's header).
import "#test/top-layer-shim";

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CausalityPanel } from "#components/graph/CausalityPanel";
import type { DomainEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));
vi.mock(import("#lib/tauri"), () => ({ invoke }) as never);

function ev(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, "seq" | "type" | "payload">,
): DomainEvent {
  return { ts: overrides.seq * 1000, ...overrides };
}

function createWorker(overrides?: Partial<Worker>): Worker {
  return {
    id: crypto.randomUUID(),
    state: "running",
    name: "Test Worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStores(): void {
  act(() => {
    for (const [id] of useWorkerStore.getState().workers) {
      useWorkerStore.getState().removeWorker(id);
    }
    useProvenanceStore.getState().reset();
  });
}

/** Seeds the provenance store's bySeq ring directly (via ingestEvent) so the component tests below never depend on invoke() mock ordering. */
function seedRing(...events: DomainEvent[]): void {
  act(() => {
    for (const e of events) useProvenanceStore.getState().ingestEvent(e);
  });
}

/** Renders the panel against a fresh jotai store (no cross-test atom leakage). */
function renderPanel(startSeq: number, onClose = vi.fn()) {
  const store = createStore();
  const view = render(
    <Provider store={store}>
      <CausalityPanel startSeq={startSeq} onClose={onClose} />
    </Provider>,
  );
  const dialog = view.container.ownerDocument.querySelector("dialog");
  if (!dialog) throw new Error("no dialog rendered");
  return { ...view, store, onClose, dialog };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("CausalityPanel (component)", () => {
  afterEach(resetStores);

  it("opens as a modal dialog named by its heading", () => {
    invoke.mockResolvedValue([]);
    const { dialog } = renderPanel(1);

    expect(dialog.open).toBe(true);
    expect(screen.getByRole("dialog", { name: "Causality Trace" })).toBe(dialog);
  });

  it("renders a root-first ordered trace, seq shown per row, entirely from the ring", async () => {
    act(() => {
      useWorkerStore.getState().addWorker(createWorker({ id: "w-a", name: "Worker Alpha" }));
      useWorkerStore.getState().addWorker(createWorker({ id: "w-b", name: "Worker Beta" }));
    });
    seedRing(
      ev({ seq: 412, type: "agent_turn_started", payload: { workerId: "w-a" } }),
      ev({
        seq: 418,
        type: "worker_spawned",
        originWorker: "w-a",
        causeSeq: 412,
        payload: { workerId: "w-b", name: "Worker Beta", pid: 1 },
      }),
    );

    renderPanel(418);

    const trace = await screen.findByRole("list", { name: "Causes, Earliest First" });
    const items = trace.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(/Worker Alpha's Turn.*@412/);
    expect(items[1]).toHaveTextContent(/Spawned Worker Beta.*@418/);
    expect(invoke).not.toHaveBeenCalled(); // both hops served from the ring
  });

  it("clicking a row for a live worker selects it, opens the detail panel and closes the inspector", async () => {
    const user = userEvent.setup();
    act(() => {
      useWorkerStore.getState().addWorker(createWorker({ id: "w-b", name: "Worker Beta" }));
    });
    seedRing(
      ev({
        seq: 1,
        type: "worker_spawned",
        payload: { workerId: "w-b", name: "Worker Beta", pid: 1 },
      }),
    );

    const { store, onClose, dialog } = renderPanel(1);
    await user.click(await screen.findByRole("button", { name: /Spawned Worker Beta/ }));

    expect(store.get(selectedWorkerIdAtom)).toBe("w-b");
    expect(store.get(detailPanelOpenAtom)).toBe(true);
    expect(dialog.open).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a row for a departed worker as plain text, not a disabled button", async () => {
    seedRing(ev({ seq: 7, type: "worker_killed", payload: { workerId: "w-ghost" } }));

    renderPanel(7);

    expect(await screen.findByText(/Killed w-ghost/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Killed/ })).not.toBeInTheDocument();
  });

  it("calls onClose when Escape closes the dialog", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue([]);
    const { onClose, dialog } = renderPanel(999);

    await user.keyboard("{Escape}");

    expect(dialog.open).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click, where `closedby` is missing", async () => {
    invoke.mockResolvedValue([]);
    const { onClose, dialog } = renderPanel(999);

    // A backdrop click is pressed and released on the dialog at a point
    // outside its box.
    act(() => {
      dialog.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: -1, clientY: -1 }),
      );
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: -1, clientY: -1 }));
    });

    expect(dialog.open).toBe(false);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("stays open when a press inside the panel is released on the backdrop", () => {
    invoke.mockResolvedValue([]);
    const { onClose, dialog } = renderPanel(999);

    // A drag that starts on the panel heading and ends outside the dialog.
    act(() => {
      screen
        .getByRole("heading", { name: "Causality Trace" })
        .dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }),
        );
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: -1, clientY: -1 }));
    });

    expect(dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the close button", async () => {
    const user = userEvent.setup();
    invoke.mockResolvedValue([]);
    const { onClose } = renderPanel(999);

    await user.click(screen.getByRole("button", { name: "Close Causality Trace" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open under StrictMode's effect replay (its queued close event is stale)", async () => {
    invoke.mockResolvedValue([]);
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Provider store={createStore()}>
          <CausalityPanel startSeq={999} onClose={onClose} />
        </Provider>
      </StrictMode>,
    );

    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Causality Trace" })).toHaveAttribute("open");
  });

  it("does not call onClose when unmounted by its owner", () => {
    invoke.mockResolvedValue([]);
    const { onClose, dialog, unmount } = renderPanel(999);

    unmount();

    expect(dialog.open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the "Cause Event Not Available" row when the walk finds nothing at all (incomplete, zero rows)', async () => {
    invoke.mockResolvedValueOnce([]); // seq 999 is neither cached nor persisted

    renderPanel(999);

    expect(
      await screen.findByText("Cause Event Not Available (Ephemeral Or Pruned)"),
    ).toBeInTheDocument();
  });

  it('renders the "Cause Event Not Available" row above a partial trace when a mid-walk lookup misses', async () => {
    act(() => {
      useWorkerStore.getState().addWorker(createWorker({ id: "w-b", name: "Worker Beta" }));
    });
    seedRing(
      ev({
        seq: 50,
        type: "worker_killed",
        originWorker: "w-a",
        causeSeq: 10, // never resolves
        payload: { workerId: "w-b" },
      }),
    );
    invoke.mockResolvedValueOnce([]); // confirms seq 10 isn't persisted

    renderPanel(50);

    expect(
      await screen.findByText("Cause Event Not Available (Ephemeral Or Pruned)"),
    ).toBeInTheDocument();
    // The one row that DID resolve still renders -- an incomplete trace
    // isn't the same as an empty one.
    expect(screen.getByText(/Killed Worker Beta/)).toBeInTheDocument();
  });

  it("reports a rejected events_since as a load failure, not a pruned cause", async () => {
    act(() => {
      useWorkerStore.getState().addWorker(createWorker({ id: "w-b", name: "Worker Beta" }));
    });
    seedRing(
      ev({
        seq: 50,
        type: "worker_killed",
        originWorker: "w-a",
        causeSeq: 10,
        payload: { workerId: "w-b" },
      }),
    );
    invoke.mockRejectedValueOnce("database is locked");

    renderPanel(50);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could Not Load The Causality Trace: database is locked",
    );
    expect(screen.queryByText(/Ephemeral Or Pruned/)).not.toBeInTheDocument();
    expect(screen.getByText(/Killed Worker Beta/)).toBeInTheDocument();
  });

  it("reports a schema-invalid events_since page as a load failure, not a pruned cause", async () => {
    act(() => {
      useWorkerStore.getState().addWorker(createWorker({ id: "w-b", name: "Worker Beta" }));
    });
    seedRing(
      ev({
        seq: 50,
        type: "worker_killed",
        originWorker: "w-a",
        causeSeq: 10,
        payload: { workerId: "w-b" },
      }),
    );
    invoke.mockResolvedValueOnce([{ seq: "not-a-number" }]);

    renderPanel(50);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could Not Load The Causality Trace: Events Since Returned An Unexpected Shape.",
    );
    expect(screen.queryByText(/Ephemeral Or Pruned/)).not.toBeInTheDocument();
  });

  it("announces the walk through one persistent status region", async () => {
    const lookup = Promise.withResolvers<DomainEvent[]>();
    invoke.mockImplementationOnce(() => lookup.promise);
    seedRing(ev({ seq: 30, type: "worker_input", causeSeq: 25, payload: { workerId: "w" } }));

    renderPanel(30);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading Causality Trace");

    await act(async () => {
      lookup.resolve([]);
    });
    await waitFor(() =>
      expect(status).toHaveTextContent("1 Event In Trace, Earlier Causes Unavailable"),
    );
  });

  it("aborts a walk still in flight when it closes", async () => {
    const lookup = Promise.withResolvers<DomainEvent[]>();
    seedRing(ev({ seq: 30, type: "worker_input", causeSeq: 20, payload: { workerId: "w" } }));
    invoke.mockImplementationOnce(() => lookup.promise);

    const { unmount } = renderPanel(30);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      lookup.resolve([
        ev({ seq: 20, type: "worker_input", causeSeq: 10, payload: { workerId: "w" } }),
      ]);
    });

    expect(invoke).toHaveBeenCalledTimes(1); // seq 10 is never fetched after close
  });
});

describe("CausalityPanel — Trojan Source", () => {
  it("shows worker names, input previews, topics and paths with bidi overrides as escaped data", async () => {
    act(() => {
      useWorkerStore.getState().addWorker(createWorker({ id: "w-a", name: "Al\u202Epha" }));
      useWorkerStore.getState().addWorker(createWorker({ id: "w-b", name: "Beta" }));
    });
    seedRing(
      ev({ seq: 1, type: "agent_turn_started", payload: { workerId: "w-a" } }),
      ev({
        seq: 2,
        type: "worker_input",
        causeSeq: 1,
        payload: { workerId: "w-b", preview: "rm \u202Egnp.exe" },
      }),
      ev({
        seq: 3,
        type: "bus_message",
        causeSeq: 2,
        payload: { fromWorker: "w-a", toWorker: "w-b", topic: "t\u202Ex" },
      }),
      ev({ seq: 4, type: "file_written", causeSeq: 3, payload: { path: "/p/a\u202Eb" } }),
    );

    const { dialog } = renderPanel(4);

    const trace = await screen.findByRole("list", { name: "Causes, Earliest First" });
    expect(trace).toHaveTextContent(String.raw`Al\u202Epha's Turn`);
    expect(trace).toHaveTextContent(String.raw`Beta Ran rm \u202Egnp.exe`);
    expect(trace).toHaveTextContent(String.raw`Sent "t\u202Ex" To Beta`);
    expect(trace).toHaveTextContent(String.raw`Wrote /p/a\u202Eb`);
    expect(dialog.textContent).not.toContain("\u202E");
  });
});
