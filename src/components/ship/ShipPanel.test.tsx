import { openUrl } from "@tauri-apps/plugin-opener";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShipPanel } from "#components/ship/ShipPanel";
import type { DomainEvent } from "#lib/event-bus";
import { ShipCommandError } from "#lib/tauri";
import type { ShipContext, ShipPreflight } from "#store/types";

// ── Mocks: the real useShip, driven through a fake event bus + IPC ──

type Handler = (e: DomainEvent) => void;
const handlers = new Map<string, Set<Handler>>();

function emit(type: string, payload: unknown): void {
  const e: DomainEvent = { seq: 1, ts: 0, type, payload };
  for (const h of [...(handlers.get(type) ?? []), ...(handlers.get("*") ?? [])]) h(e);
}

vi.mock(import("#lib/event-bus"), () => ({
  onEvent: (type: string, handler: Handler) => {
    const set = handlers.get(type) ?? new Set<Handler>();
    handlers.set(type, set);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  },
  waitFor: (predicate: (e: DomainEvent) => boolean) =>
    new Promise<DomainEvent>((resolve) => {
      const wildcard = handlers.get("*") ?? new Set<Handler>();
      handlers.set("*", wildcard);
      const wrapped: Handler = (e) => {
        if (!predicate(e)) return;
        wildcard.delete(wrapped);
        resolve(e);
      };
      wildcard.add(wrapped);
    }),
}));

const mockGitShipPreflight = vi.fn<(workerId: string, mode?: string) => Promise<ShipPreflight>>();
const mockGitStageCommit = vi.fn();
const mockGitPush = vi.fn();
const mockShipCompareUrl = vi.fn();
const mockShipContext = vi.fn<(workerId: string) => Promise<ShipContext>>();

vi.mock(import("#lib/tauri"), async (importOriginal) => ({
  ...(await importOriginal()),
  gitShipPreflight: (...args) => mockGitShipPreflight(...args),
  gitStageCommit: (...args) => mockGitStageCommit(...args),
  gitPush: (...args) => mockGitPush(...args),
  shipCompareUrl: (...args) => mockShipCompareUrl(...args),
  shipContext: (...args) => mockShipContext(...args),
}));

// ── Fixtures ──────────────────────────────────────────

const WORKER_A = "aaaaaaaa-1111-4222-8333-444444444444";
const WORKER_B = "bbbbbbbb-1111-4222-8333-444444444444";
const COMPARE_URL = "https://github.com/example/repo/compare/main...swarm/agent-abcd1234";

function makePreflight(overrides: Partial<ShipPreflight> = {}): ShipPreflight {
  return {
    workerId: WORKER_A,
    branch: "swarm/agent-abcd1234",
    baseBranch: "main",
    remote: "https://github.com/example/repo.git",
    host: "github.com",
    hostSupportsCompare: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: ["src/main.ts"],
    untracked: [],
    skipped: [],
    diffStat: { filesChanged: 1, insertions: 5, deletions: 1 },
    canShip: true,
    blockers: [],
    ...overrides,
  };
}

function makeContext(workerId: string): ShipContext {
  return {
    workerId,
    seqFrom: 0,
    seqTo: 0,
    turns: [],
    commits: [],
    omittedTurnCount: 0,
    eventsTruncated: false,
    hasUncapturedWebviewActivity: false,
  };
}

// The opener plugin needs the Tauri bridge; the flag opts the suite into it.
beforeEach(() => {
  vi.stubGlobal("isTauri", true);
  handlers.clear();
  vi.clearAllMocks();
  mockShipContext.mockImplementation(async (workerId) => makeContext(workerId));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderShipped(user: ReturnType<typeof userEvent.setup>) {
  mockGitShipPreflight.mockResolvedValue(makePreflight());
  mockGitStageCommit.mockResolvedValue({
    sha: "deadbeefcafe0123",
    filesChanged: 1,
    insertions: 5,
    deletions: 1,
    seqFrom: 0,
    seqTo: 1,
    skipped: [],
  });
  mockGitPush.mockResolvedValue({ pushedRef: "swarm/agent-abcd1234", sha: "deadbeefcafe0123" });
  mockShipCompareUrl.mockImplementation(async (workerId: string, shipId: string) => {
    emit("ship_settled", { shipId, workerId });
    return COMPARE_URL;
  });

  render(<ShipPanel workerId={WORKER_A} />);
  await user.click(
    await screen.findByRole("button", { name: "Commit + Push + Open Compare Page" }),
  );
  return screen.findByRole("status");
}

describe("ShipPanel", () => {
  it("runs preflight on mount and shows the preview", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    render(<ShipPanel workerId={WORKER_A} />);

    expect(screen.getByText("Running Ship Preflight…")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Commit Only" })).toBeEnabled();
    expect(mockGitShipPreflight).toHaveBeenCalledExactlyOnceWith(WORKER_A, "all");
  });

  it("never lets a late preflight for the previous worker land in the newly selected worker's preview", async () => {
    const lateA = Promise.withResolvers<ShipPreflight>();
    mockGitShipPreflight.mockImplementation((workerId) =>
      workerId === WORKER_A
        ? lateA.promise
        : Promise.resolve(
            makePreflight({ workerId: WORKER_B, branch: "swarm/agent-bbbb", unstaged: ["b.ts"] }),
          ),
    );

    const { rerender } = render(<ShipPanel workerId={WORKER_A} />);
    rerender(<ShipPanel workerId={WORKER_B} />);
    expect(await screen.findByText("swarm/agent-bbbb")).toBeInTheDocument();
    const message = screen.getByLabelText<HTMLTextAreaElement>("Commit Message");
    expect(message.value).toContain("update b.ts");

    await act(async () => {
      lateA.resolve(makePreflight({ unstaged: ["a.ts"] }));
    });

    expect(screen.getByText("swarm/agent-bbbb")).toBeInTheDocument();
    expect(screen.queryByText("swarm/agent-abcd1234")).not.toBeInTheDocument();
    expect(message.value).toContain("update b.ts");
    expect(message.value).not.toContain("a.ts");
  });

  it("shows a failed action's kind, message and remedy command, and refreshes the preview on request", async () => {
    const user = userEvent.setup();
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue({
      sha: "deadbeefcafe0123",
      filesChanged: 1,
      insertions: 5,
      deletions: 1,
      seqFrom: 0,
      seqTo: 1,
      skipped: [],
    });
    mockGitPush.mockRejectedValue(
      new ShipCommandError({
        kind: "pushRejected",
        message: "Push Rejected — Fetch And Rebase, Then Ship Again.",
        remedy: "fetchAndRebase",
      }),
    );

    render(<ShipPanel workerId={WORKER_A} />);
    await user.click(await screen.findByRole("button", { name: "Commit + Push" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Push Rejected")).toBeInTheDocument();
    expect(
      within(alert).getByText("Push Rejected — Fetch And Rebase, Then Ship Again."),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText("git pull --rebase origin swarm/agent-abcd1234"),
    ).toBeInTheDocument();
    // The preview stays visible for a retry.
    expect(screen.getByRole("button", { name: "Commit Only" })).toBeInTheDocument();

    const callsBefore = mockGitShipPreflight.mock.calls.length;
    await user.click(within(alert).getByRole("button", { name: "Refresh Preflight" }));
    expect(mockGitShipPreflight.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("renders the <branch> placeholder for a branch name carrying shell metacharacters", async () => {
    const user = userEvent.setup();
    mockGitShipPreflight.mockResolvedValue(makePreflight({ branch: "w$(id);x" }));
    mockGitStageCommit.mockResolvedValue({
      sha: "deadbeefcafe0123",
      filesChanged: 1,
      insertions: 5,
      deletions: 1,
      seqFrom: 0,
      seqTo: 1,
      skipped: [],
    });
    mockGitPush.mockRejectedValue(
      new ShipCommandError({
        kind: "pushRejected",
        message: "Push Rejected — Fetch And Rebase, Then Ship Again.",
        remedy: "fetchAndRebase",
      }),
    );

    render(<ShipPanel workerId={WORKER_A} />);
    await user.click(await screen.findByRole("button", { name: "Commit + Push" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("git pull --rebase origin <branch>")).toBeInTheDocument();
  });

  it("offers Retry Preflight when preflight itself failed", async () => {
    const user = userEvent.setup();
    mockGitShipPreflight
      .mockRejectedValueOnce(
        new ShipCommandError({
          kind: "noWorktree",
          message: "This Worker Has No Worktree.",
          remedy: null,
        }),
      )
      .mockResolvedValueOnce(makePreflight());

    render(<ShipPanel workerId={WORKER_A} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("No Worktree To Ship")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Retry Preflight" }));
    expect(await screen.findByRole("button", { name: "Commit Only" })).toBeInTheDocument();
  });

  it("shows the receipt and re-opens the compare page through the opener plugin", async () => {
    const user = userEvent.setup();
    const receipt = await renderShipped(user);

    expect(within(receipt).getByText("Shipped")).toBeInTheDocument();
    expect(within(receipt).getByText("deadbeefcafe")).toBeInTheDocument();
    // The auto-open after settling.
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(COMPARE_URL);

    await user.click(within(receipt).getByRole("button", { name: "Open Compare Page" }));
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("opens the compare page in a browser tab, not the opener plugin, without the Tauri bridge", async () => {
    vi.unstubAllGlobals();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    const receipt = await renderShipped(user);
    // useShip's post-ship auto-open still calls the plugin (and catches its failure).
    const autoOpenCalls = vi.mocked(openUrl).mock.calls.length;

    await user.click(within(receipt).getByRole("button", { name: "Open Compare Page" }));

    expect(open).toHaveBeenCalledWith(COMPARE_URL, "_blank", "noopener,noreferrer");
    expect(openUrl).toHaveBeenCalledTimes(autoOpenCalls);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("moves focus to the receipt when the ship button that started the flow unmounts", async () => {
    const user = userEvent.setup();
    const receipt = await renderShipped(user);

    expect(receipt).toHaveFocus();
  });

  it("surfaces a receipt opener rejection as a Title Case error toast instead of an unhandled rejection", async () => {
    const user = userEvent.setup();
    const receipt = await renderShipped(user);
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no default browser configured"));

    await user.click(within(receipt).getByRole("button", { name: "Open Compare Page" }));

    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Could Not Open The Compare Page: no default browser configured",
      );
    });
  });
});
