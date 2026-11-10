// ── WorkerDetail Tests ──────────────────────────────
//
// The detail panel's controls (Pause/Resume/Kill as shared Pills, Title
// Case names, state-dependent disabling), the IPC each one reaches, the
// optimistic state holding while that IPC is in flight, the worktree
// opener (desktop only), the escape-stripped output preview and the
// Related Workers lineage list (rows as buttons, Tab order, selection,
// paging, the failed count).

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getDefaultStore, useAtomValue } from "jotai";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerDetail } from "#components/graph/WorkerDetail";
import { useProvenanceStore } from "#store/provenance";
import type { Worker } from "#store/types";
import { detailPanelOpenAtom, selectedWorkerIdAtom } from "#store/ui";
import { useWorkerStore } from "#store/workers";

// The IPC wrappers useWorker calls, the worktree opener, and the
// transport check that gates it.
const tauri = vi.hoisted(() => ({
  pauseWorker: vi.fn(async (_id: string) => {}),
  resumeWorker: vi.fn(async (_id: string) => {}),
  killWorker: vi.fn(async (_id: string) => {}),
  openWorkerDirectory: vi.fn(async (_workerId: string) => {}),
  isTauri: vi.fn(() => true),
}));
vi.mock(import("#lib/tauri"), () => tauri as never);
const {
  pauseWorker: mockPauseWorker,
  resumeWorker: mockResumeWorker,
  killWorker: mockKillWorker,
} = tauri;

function createWorker(overrides?: Partial<Worker>): Worker {
  return {
    id: crypto.randomUUID(),
    state: "running",
    name: "test-worker",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function resetStore(): void {
  act(() => {
    const state = useWorkerStore.getState();
    for (const [id] of state.workers) {
      state.removeWorker(id);
    }
    useProvenanceStore.getState().reset();
  });
}

function seedWorker(worker: Worker): void {
  act(() => {
    useWorkerStore.getState().addWorker(worker);
  });
}

describe("WorkerDetail", () => {
  beforeEach(resetStore);
  afterEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('renders Kill as a real, interactive button with data-tone="danger"', () => {
    const worker = createWorker();
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    const killButton = screen.getByRole("button", { name: "Kill" });
    expect(killButton.tagName).toBe("BUTTON");
    expect(killButton).toHaveAttribute("data-tone", "danger");
    expect(killButton).toHaveAttribute("data-interactive", "true");
  });

  it("invokes the kill IPC handler when Kill is clicked", async () => {
    const user = userEvent.setup();
    const worker = createWorker();
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Kill" }));

    expect(mockKillWorker).toHaveBeenCalledTimes(1);
    expect(mockKillWorker).toHaveBeenCalledWith(worker.id);
  });

  it("Kill stays enabled regardless of worker state (always available)", () => {
    const worker = createWorker({ state: "idle" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Kill" })).toBeEnabled();
  });

  it("renders Pause and Resume with neutral tone", () => {
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("data-tone", "neutral");
  });

  it("enables Pause and disables Resume when the worker is running", () => {
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  });

  it("enables Resume and disables Pause when the worker is paused", () => {
    const worker = createWorker({ state: "paused" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  });

  it("disables both Pause and Resume when the worker is idle", () => {
    const worker = createWorker({ state: "idle" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  });

  it("invokes the pause IPC handler when Pause is clicked and enabled", async () => {
    const user = userEvent.setup();
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(mockPauseWorker).toHaveBeenCalledWith(worker.id);
  });

  it("invokes the resume IPC handler when Resume is clicked and enabled", async () => {
    const user = userEvent.setup();
    const worker = createWorker({ state: "paused" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect(mockResumeWorker).toHaveBeenCalledWith(worker.id);
  });

  it("does not invoke the resume IPC handler when Resume is disabled", async () => {
    const user = userEvent.setup();
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect(mockResumeWorker).not.toHaveBeenCalled();
  });

  it("keeps Title Case accessible names for Kill, Pause, and Resume", () => {
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("button", { name: "Kill" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("holds the optimistic state while the pause IPC is in flight", async () => {
    const user = userEvent.setup();
    const { promise, resolve } = Promise.withResolvers<void>();
    mockPauseWorker.mockReturnValueOnce(promise);
    const worker = createWorker({ state: "running" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByRole("button", { name: "Pause" }));

    // Still in flight: the badge already reads Paused and Resume is live.
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
    await act(async () => resolve());
    expect(useWorkerStore.getState().workers.get(worker.id)?.state).toBe("paused");
  });

  it("strips terminal escape sequences from the output preview", () => {
    const worker = createWorker({ output: "\u001b[1;32mok\u001b[0m\r\ndone" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByRole("region", { name: "Output" })).toHaveTextContent(/^Outputok\s*done$/);
  });

  // ── Worktree isolation rows ──────────────────────────────────────

  it("shows no Branch or Worktree row for a worker spawned without isolation", () => {
    const worker = createWorker();
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.queryByText("Branch")).not.toBeInTheDocument();
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
  });

  it("shows Branch and Worktree rows for an isolated worker", () => {
    const worker = createWorker({
      branch: "swarm/research-agent-11112222",
      worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-11112222",
    });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByText("Branch")).toBeInTheDocument();
    expect(screen.getByText("swarm/research-agent-11112222")).toBeInTheDocument();
    expect(screen.getByText("Worktree")).toBeInTheDocument();
    expect(
      screen.getByText("/home/user/.swarm/worktrees/repo-abcd1234/w-11112222"),
    ).toBeInTheDocument();
  });

  it("opens the worker's own worktree folder by worker id when clicked", async () => {
    const user = userEvent.setup();
    const worker = createWorker({
      branch: "swarm/agent-11112222",
      worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-11112222",
    });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByText("/home/user/.swarm/worktrees/repo-abcd1234/w-11112222"));

    expect(tauri.openWorkerDirectory).toHaveBeenCalledExactlyOnceWith(worker.id);
  });

  it("surfaces an opener rejection as a Title Case error toast", async () => {
    const user = userEvent.setup();
    tauri.openWorkerDirectory.mockRejectedValueOnce(
      new Error("Refusing To Open The Worktree: It Is Not A Directory."),
    );
    const worker = createWorker({
      worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-33334444",
    });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByText("/home/user/.swarm/worktrees/repo-abcd1234/w-33334444"));

    expect(toast.error).toHaveBeenCalledWith(
      "Could Not Open Worktree: Refusing To Open The Worktree: It Is Not A Directory.",
    );
  });

  it("shows the worktree as plain text outside the desktop app (no opener plugin)", () => {
    tauri.isTauri.mockReturnValue(false);
    const worker = createWorker({ worktreePath: "/srv/worktrees/w-1" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByText("/srv/worktrees/w-1").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "/srv/worktrees/w-1" })).not.toBeInTheDocument();
    tauri.isTauri.mockReturnValue(true);
  });

  it("never sends the displayed path, so a traversal-shaped one opens nothing it names", async () => {
    const user = userEvent.setup();
    const worker = createWorker({
      worktreePath: "/home/user/.swarm/worktrees/../../etc",
    });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByText("/home/user/.swarm/worktrees/../../etc"));

    // Only the id crosses IPC; the shell opens the path its registry
    // recorded, never one the webview supplies.
    expect(tauri.openWorkerDirectory).toHaveBeenCalledExactlyOnceWith(worker.id);
  });

  describe("closing the panel", () => {
    // jsdom has no layout, so every element reports zero client rects;
    // `visible` marks the ones standing in for a rendered view.
    function stubLayout(...visible: HTMLElement[]): void {
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return (visible.includes(this as HTMLElement) ? [new DOMRect()] : []) as never;
      });
    }

    function mountViews(workerId: string) {
      const node = document.createElement("div");
      node.className = "react-flow__node";
      node.setAttribute("data-id", workerId);
      node.tabIndex = 0;
      const row = document.createElement("button");
      row.setAttribute("aria-current", "true");
      const li = document.createElement("li");
      li.append(row);
      document.body.append(node, li);
      return {
        node,
        row,
        cleanup: () => {
          node.remove();
          li.remove();
        },
      };
    }

    afterEach(() => vi.restoreAllMocks());

    it("returns focus to the worker's graph node when the graph is showing", async () => {
      const user = userEvent.setup();
      const worker = createWorker();
      seedWorker(worker);
      const { node, row, cleanup } = mountViews(worker.id);
      stubLayout(node);
      render(<WorkerDetail worker={worker} />);

      await user.click(screen.getByRole("button", { name: "Close Detail Panel" }));

      expect(node).toHaveFocus();
      expect(row).not.toHaveFocus();
      cleanup();
    });

    it("returns focus to the selected list row when the graph is hidden", async () => {
      const user = userEvent.setup();
      const worker = createWorker();
      seedWorker(worker);
      const { row, cleanup } = mountViews(worker.id);
      stubLayout(row);
      render(<WorkerDetail worker={worker} />);

      await user.click(screen.getByRole("button", { name: "Close Detail Panel" }));

      expect(row).toHaveFocus();
      cleanup();
    });
  });
});

describe("WorkerDetail — Trojan Source", () => {
  afterEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("shows the name, branch and worktree path with bidi overrides as escaped data", () => {
    const worker = createWorker({
      name: "w\u202Eorker",
      branch: "swarm/a\u202Eb",
      worktreePath: "/wt/c\u202Ed",
    });
    seedWorker(worker);
    const { container } = render(<WorkerDetail worker={worker} />);

    expect(screen.getByText(String.raw`w\u202Eorker`)).toBeInTheDocument();
    expect(screen.getByText(String.raw`swarm/a\u202Eb`)).toBeInTheDocument();
    const path = screen.getByText(String.raw`/wt/c\u202Ed`);
    expect(path).toHaveAttribute("title", String.raw`/wt/c\u202Ed`);
    expect(container.textContent).not.toContain("\u202E");
  });

  it("escapes the worktree path outside the desktop app too", () => {
    tauri.isTauri.mockReturnValue(false);
    const worker = createWorker({ worktreePath: "/wt/c\u202Ed" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByText(String.raw`/wt/c\u202Ed`)).toHaveAttribute(
      "title",
      String.raw`/wt/c\u202Ed`,
    );
    tauri.isTauri.mockReturnValue(true);
  });

  it("opens by worker id, never by the escaped display text", async () => {
    const worker = createWorker({ worktreePath: "/wt/e\u202Ef" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await userEvent.setup().click(screen.getByTitle(String.raw`/wt/e\u202Ef`));

    expect(tauri.openWorkerDirectory).toHaveBeenCalledExactlyOnceWith(worker.id);
  });
});

/** The panel as the Workers page mounts it: keyed by the selected worker, so a selection remounts it. */
function SelectedDetail(): React.ReactElement | null {
  const id = useAtomValue(selectedWorkerIdAtom);
  const selected = useWorkerStore((s) => (id === null ? undefined : s.workers.get(id)));
  return selected ? <WorkerDetail key={selected.id} worker={selected} /> : null;
}

describe("WorkerDetail — Related Workers", () => {
  let seq = 0;

  /** Feeds one stamped envelope through the provenance store; returns its seq. */
  function ingest(
    type: "agent_turn_started" | "worker_spawned" | "worker_input",
    originWorker: string,
    workerId: string,
    causeSeq?: number,
  ): number {
    seq += 1;
    const event = { seq, ts: seq * 1000, type, originWorker, causeSeq, payload: { workerId } };
    act(() => useProvenanceStore.getState().ingestEvent(event));
    return seq;
  }

  function lineageButtons(): HTMLElement[] {
    return within(screen.getByRole("list", { name: "Related Workers" })).getAllByRole("button");
  }

  beforeEach(() => {
    seq = 0;
    resetStore();
    act(() => getDefaultStore().set(selectedWorkerIdAtom, null));
  });
  afterEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("shows no list for a worker with no measured relations", () => {
    const worker = createWorker();
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    expect(screen.queryByRole("list", { name: "Related Workers" })).not.toBeInTheDocument();
  });

  it("lists the parent, the children and the causes as buttons in Tab order, each with its status", async () => {
    const user = userEvent.setup();
    const parent = createWorker({ name: "Orchestrator" });
    const worker = createWorker({ name: "Planner" });
    const child = createWorker({ name: "Lint Fixer", state: "error" });
    const reviewer = createWorker({ name: "Reviewer", state: "idle" });
    for (const w of [parent, worker, child, reviewer]) seedWorker(w);
    const turn = ingest("agent_turn_started", parent.id, parent.id);
    const spawn = ingest("worker_spawned", parent.id, worker.id, turn);
    ingest("worker_spawned", worker.id, child.id, spawn);
    ingest("worker_input", reviewer.id, worker.id, spawn);
    render(<WorkerDetail worker={worker} />);

    const rows = await screen.findAllByRole("button", {
      name: /^(Spawned By|Spawned|Caused By): /,
    });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Spawned By: Orchestrator, Status: Running",
      "Spawned: Lint Fixer, Status: Error",
      "Caused By: Reviewer, Status: Idle",
    ]);
    expect(lineageButtons()).toEqual(rows);

    rows[0]?.focus();
    await user.tab();
    expect(rows[1]).toHaveFocus();
    await user.tab();
    expect(rows[2]).toHaveFocus();
  });

  it("selects the related worker when its row is activated", async () => {
    const user = userEvent.setup();
    const parent = createWorker({ name: "Orchestrator" });
    const worker = createWorker({ name: "Planner" });
    seedWorker(parent);
    seedWorker(worker);
    ingest("worker_spawned", parent.id, worker.id);
    render(<WorkerDetail worker={worker} />);

    screen.getByRole("button", { name: /^Spawned By: Orchestrator/ }).focus();
    await user.keyboard("{Enter}");

    expect(getDefaultStore().get(selectedWorkerIdAtom)).toBe(parent.id);
    expect(getDefaultStore().get(detailPanelOpenAtom)).toBe(true);
  });

  it("moves focus to the selected worker's panel heading when a row opens it", async () => {
    const user = userEvent.setup();
    const parent = createWorker({ name: "Orchestrator" });
    const worker = createWorker({ name: "Planner" });
    seedWorker(parent);
    seedWorker(worker);
    ingest("worker_spawned", parent.id, worker.id);
    act(() => getDefaultStore().set(selectedWorkerIdAtom, worker.id));
    render(<SelectedDetail />);

    await user.click(screen.getByRole("button", { name: /^Spawned By: Orchestrator/ }));

    expect(screen.getByText("Orchestrator")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Worker Detail" })).toHaveFocus();
  });

  it("shows the first 6 rows, then 12 more per Show More, and counts the failed workers", async () => {
    const user = userEvent.setup();
    const worker = createWorker({ name: "Planner" });
    seedWorker(worker);
    const children = Array.from({ length: 20 }, (_, i) =>
      createWorker({ name: `Child ${i}`, state: i % 5 === 0 ? "error" : "running" }),
    );
    for (const child of children) {
      seedWorker(child);
      ingest("worker_spawned", worker.id, child.id);
    }
    render(<WorkerDetail worker={worker} />);

    expect(screen.getByText("4 Failed")).toBeInTheDocument();
    expect(lineageButtons()).toHaveLength(6);

    await user.click(screen.getByRole("button", { name: "Show More" }));
    expect(lineageButtons()).toHaveLength(18);

    await user.click(screen.getByRole("button", { name: "Show More" }));
    expect(lineageButtons()).toHaveLength(20);
    expect(screen.queryByRole("button", { name: "Show More" })).not.toBeInTheDocument();
  });

  it("shows no failed count when no related worker failed", () => {
    const parent = createWorker({ name: "Orchestrator" });
    const worker = createWorker({ name: "Planner" });
    seedWorker(parent);
    seedWorker(worker);
    ingest("worker_spawned", parent.id, worker.id);
    render(<WorkerDetail worker={worker} />);

    expect(screen.queryByText(/Failed$/)).not.toBeInTheDocument();
  });
});
