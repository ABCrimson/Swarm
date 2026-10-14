// ── WorkerDetail Tests ──────────────────────────────
//
// The detail panel's controls (Pause/Resume/Kill as shared Pills, Title
// Case names, state-dependent disabling), the IPC each one reaches, the
// optimistic state holding while that IPC is in flight, the worktree
// opener (desktop only) and the escape-stripped output preview.

import { openPath } from "@tauri-apps/plugin-opener";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerDetail } from "#components/graph/WorkerDetail";
import type { Worker } from "#store/types";
import { useWorkerStore } from "#store/workers";

// The IPC wrappers useWorker calls, plus the transport check that gates
// the worktree opener.
const tauri = vi.hoisted(() => ({
  pauseWorker: vi.fn(async (_id: string) => {}),
  resumeWorker: vi.fn(async (_id: string) => {}),
  killWorker: vi.fn(async (_id: string) => {}),
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

  it("opens the worktree folder via the opener plugin when clicked", async () => {
    const user = userEvent.setup();
    const worker = createWorker({
      branch: "swarm/agent-11112222",
      worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-11112222",
    });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByText("/home/user/.swarm/worktrees/repo-abcd1234/w-11112222"));

    expect(openPath).toHaveBeenCalledWith("/home/user/.swarm/worktrees/repo-abcd1234/w-11112222");
  });

  it("surfaces an opener rejection as a Title Case error toast", async () => {
    const user = userEvent.setup();
    vi.mocked(openPath).mockRejectedValueOnce(new Error("not allowed by scope"));
    const worker = createWorker({
      worktreePath: "/home/user/.swarm/worktrees/repo-abcd1234/w-33334444",
    });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByText("/home/user/.swarm/worktrees/repo-abcd1234/w-33334444"));

    expect(toast.error).toHaveBeenCalledWith("Could Not Open Worktree: not allowed by scope");
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

  it("refuses a '..' traversal path without calling the opener", async () => {
    const user = userEvent.setup();
    const worker = createWorker({
      worktreePath: "/home/user/.swarm/worktrees/../../etc",
    });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await user.click(screen.getByText("/home/user/.swarm/worktrees/../../etc"));

    expect(openPath).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Refusing To Open A Path Containing '..'.");
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
      node.dataset.id = workerId;
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

  it("still opens the raw worktree path", async () => {
    const worker = createWorker({ worktreePath: "/wt/e\u202Ef" });
    seedWorker(worker);
    render(<WorkerDetail worker={worker} />);

    await userEvent.setup().click(screen.getByTitle(String.raw`/wt/e\u202Ef`));

    expect(vi.mocked(openPath)).toHaveBeenCalledWith("/wt/e\u202Ef");
  });
});
