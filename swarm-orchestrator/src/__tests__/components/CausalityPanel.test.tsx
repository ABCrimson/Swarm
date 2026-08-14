import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "#lib/event-bus";
import { useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

const invokeMock = vi.fn();
vi.mock("#lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  CausalityPanel,
  MAX_CAUSALITY_HOPS,
  walkCausalityChain,
} from "#components/graph/CausalityPanel";

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

beforeEach(() => {
  invokeMock.mockReset();
});

describe("walkCausalityChain", () => {
  it("walks entirely from the ring when every hop is cached, terminating on a real root (no causeSeq)", async () => {
    const root = ev({ seq: 412, type: "agent_turn_started", payload: { workerId: "w-a" } });
    const spawn = ev({
      seq: 418,
      type: "worker_spawned",
      originWorker: "w-a",
      causeSeq: 412,
      payload: { workerId: "w-b", name: "B", pid: 1 },
    });
    const ring = new Map([
      [root.seq, root],
      [spawn.seq, spawn],
    ]);

    const result = await walkCausalityChain(418, ring);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.rows.map((r) => r.seq)).toEqual([412, 418]); // root-first order
  });

  it("falls back to a single-row events_since backfill on a ring miss", async () => {
    const root = ev({ seq: 100, type: "agent_turn_started", payload: { workerId: "w-a" } });
    invokeMock.mockResolvedValueOnce([root]);

    const startEvent = ev({
      seq: 105,
      type: "worker_input",
      originWorker: "w-a",
      causeSeq: 100,
      payload: { workerId: "w-b", bytes: 4, source: "tool", preview: "ls\n" },
    });
    const ring = new Map([[startEvent.seq, startEvent]]); // root (100) is NOT cached

    const result = await walkCausalityChain(105, ring);

    expect(invokeMock).toHaveBeenCalledWith("events_since", { afterSeq: 99, limit: 1 });
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(false);
    expect(result.rows.map((r) => r.seq)).toEqual([100, 105]);
  });

  it("treats a backfill row whose seq doesn't match the requested seq as a miss (the row.seq !== seq guard)", async () => {
    // events_since is asked for seq 100 (afterSeq: 99) but the mocked
    // response comes back with a DIFFERENT seq -- a gap/skip in what's
    // persisted, or a malformed response. The guard must null this out
    // rather than trust the wrong row.
    const wrongSeqRow = ev({ seq: 101, type: "agent_turn_started", payload: { workerId: "w-a" } });
    invokeMock.mockResolvedValueOnce([wrongSeqRow]);

    const startEvent = ev({
      seq: 105,
      type: "worker_input",
      originWorker: "w-a",
      causeSeq: 100,
      payload: { workerId: "w-b", bytes: 4, source: "tool", preview: "ls\n" },
    });
    const ring = new Map([[startEvent.seq, startEvent]]);

    const result = await walkCausalityChain(105, ring);

    expect(invokeMock).toHaveBeenCalledWith("events_since", { afterSeq: 99, limit: 1 });
    expect(result.incomplete).toBe(true);
    expect(result.truncated).toBe(false);
    // Only the starting event resolved -- the mismatched row was rejected.
    expect(result.rows.map((r) => r.seq)).toEqual([105]);
  });

  it("ends the walk early and marks the result incomplete (not truncated) when a lookup genuinely misses", async () => {
    const startEvent = ev({
      seq: 50,
      type: "worker_killed",
      originWorker: "w-a",
      causeSeq: 10, // nothing will be found for seq 10
      payload: { workerId: "w-b" },
    });
    const ring = new Map([[startEvent.seq, startEvent]]);
    invokeMock.mockResolvedValueOnce([]); // events_since confirms nothing persisted there

    const result = await walkCausalityChain(50, ring);

    expect(result.rows.map((r) => r.seq)).toEqual([50]);
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it("terminates immediately for a root event with no causeSeq at all, marked neither truncated nor incomplete", async () => {
    const root = ev({ seq: 1, type: "agent_turn_started", payload: { workerId: "w-a" } });
    const ring = new Map([[root.seq, root]]);

    const result = await walkCausalityChain(1, ring);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.rows.map((r) => r.seq)).toEqual([1]);
    expect(result.truncated).toBe(false);
    expect(result.incomplete).toBe(false);
  });

  it(`stops at ${MAX_CAUSALITY_HOPS} rows and reports truncated (not incomplete) when the chain is deeper than the cap`, async () => {
    // A synthetic chain of 51 events (seq 1..51), each citing seq-1 as its
    // cause, with seq 1 the true (never-reached) root.
    const ring = new Map<number, DomainEvent>();
    for (let seq = 1; seq <= 51; seq++) {
      ring.set(
        seq,
        ev({
          seq,
          type: "worker_state",
          causeSeq: seq > 1 ? seq - 1 : undefined,
          payload: { workerId: "w", state: "idle" },
        }),
      );
    }

    const result = await walkCausalityChain(51, ring);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.incomplete).toBe(false);
    expect(result.rows).toHaveLength(MAX_CAUSALITY_HOPS);
    // The true root (seq 1) is excluded -- the cap bit before reaching it.
    expect(result.rows.map((r) => r.seq)).not.toContain(1);
    expect(result.rows.at(0)?.seq).toBe(2);
    expect(result.rows.at(-1)?.seq).toBe(51);
  });
});

describe("CausalityPanel (component)", () => {
  afterEach(resetStores);

  it("renders a root-first vertical trace, seq shown per row, entirely from the ring (manual-acceptance parity: an edge click traces back to the agent_turn_started seq and stops)", async () => {
    const workerA = createWorker({ id: "w-a", name: "Worker Alpha" });
    const workerB = createWorker({ id: "w-b", name: "Worker Beta" });
    act(() => {
      useWorkerStore.getState().addWorker(workerA);
      useWorkerStore.getState().addWorker(workerB);
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

    render(<CausalityPanel startSeq={418} onClose={vi.fn()} />);

    expect(await screen.findByText(/Worker Alpha's Turn/)).toBeInTheDocument();
    expect(screen.getByText(/Spawned Worker Beta/)).toBeInTheDocument();
    expect(screen.getByText("@412")).toBeInTheDocument();
    expect(screen.getByText("@418")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled(); // both hops served from the ring
  });

  it("clicking a row for a live worker selects it and opens the detail panel", async () => {
    const user = userEvent.setup();
    const workerB = createWorker({ id: "w-b", name: "Worker Beta" });
    act(() => {
      useWorkerStore.getState().addWorker(workerB);
    });
    seedRing(
      ev({
        seq: 1,
        type: "worker_spawned",
        payload: { workerId: "w-b", name: "Worker Beta", pid: 1 },
      }),
    );

    render(<CausalityPanel startSeq={1} onClose={vi.fn()} />);
    const row = await screen.findByRole("button", { name: /Spawned Worker Beta/ });

    await user.click(row);

    const store = getDefaultStore();
    expect(store.get(selectedWorkerIdAtom)).toBe("w-b");
    expect(store.get(detailPanelOpenAtom)).toBe(true);
  });

  it("disables the row when the named worker is no longer live", async () => {
    // No workers seeded -- w-ghost has already departed.
    seedRing(ev({ seq: 7, type: "worker_killed", payload: { workerId: "w-ghost" } }));

    render(<CausalityPanel startSeq={7} onClose={vi.fn()} />);

    const row = await screen.findByRole("button", { name: /Killed/ });
    expect(row).toBeDisabled();
  });

  it("calls onClose on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    invokeMock.mockResolvedValueOnce([]);

    render(<CausalityPanel startSeq={999} onClose={onClose} />);
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it('renders the "Cause Event Not Available" terminal row when the walk finds nothing at all (incomplete, zero rows)', async () => {
    invokeMock.mockResolvedValueOnce([]); // seq 999 is neither cached nor persisted

    render(<CausalityPanel startSeq={999} onClose={vi.fn()} />);

    expect(
      await screen.findByText("Cause Event Not Available (Ephemeral Or Pruned)"),
    ).toBeInTheDocument();
  });

  it('renders the "Cause Event Not Available" row above a partial trace when a mid-walk lookup misses', async () => {
    const workerB = createWorker({ id: "w-b", name: "Worker Beta" });
    act(() => {
      useWorkerStore.getState().addWorker(workerB);
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
    invokeMock.mockResolvedValueOnce([]); // confirms seq 10 isn't persisted

    render(<CausalityPanel startSeq={50} onClose={vi.fn()} />);

    expect(
      await screen.findByText("Cause Event Not Available (Ephemeral Or Pruned)"),
    ).toBeInTheDocument();
    // The one row that DID resolve still renders -- an incomplete trace
    // isn't the same as an empty one.
    expect(screen.getByText(/Killed Worker Beta/)).toBeInTheDocument();
  });

  // ── Focus management ────────────────────────────────────────────────

  it("focuses the close button on open", async () => {
    render(<CausalityPanel startSeq={1} onClose={vi.fn()} />);

    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "Close Causality Trace" })).toHaveFocus();
    });
  });

  it("restores focus to the previously focused element on close/unmount", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open Trace";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(<CausalityPanel startSeq={1} onClose={vi.fn()} />);
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "Close Causality Trace" })).toHaveFocus();
    });

    unmount();

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("traps Tab within the dialog, wrapping from the last focusable element back to the first", async () => {
    const user = userEvent.setup();
    const workerB = createWorker({ id: "w-b", name: "Worker Beta" });
    act(() => {
      useWorkerStore.getState().addWorker(workerB);
    });
    seedRing(
      ev({
        seq: 1,
        type: "worker_spawned",
        payload: { workerId: "w-b", name: "Worker Beta", pid: 1 },
      }),
    );

    render(<CausalityPanel startSeq={1} onClose={vi.fn()} />);
    const closeButton = await screen.findByRole("button", { name: "Close Causality Trace" });
    const row = screen.getByRole("button", { name: /Spawned Worker Beta/ });

    // Close button is the first focusable (and already focused on open);
    // the row is the last. Shift+Tab from the first wraps to the last.
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(row).toHaveFocus();

    // Tab from the last wraps back to the first.
    await user.tab();
    expect(closeButton).toHaveFocus();
  });

  it("does not tab focus out to a trigger element behind the modal", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "Behind The Modal";
    document.body.appendChild(trigger);

    render(<CausalityPanel startSeq={1} onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Close Causality Trace" });

    await user.tab();
    await user.tab();
    await user.tab();

    expect(trigger).not.toHaveFocus();
    trigger.remove();
  });
});
