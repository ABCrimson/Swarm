import { act, renderHook, waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShip } from "#hooks/useShip";
import { ShipCommandError } from "#lib/tauri";
import type { CommitOutcome, PushOutcome, ShipPreflight } from "#store/types";

// ── Mocks ─────────────────────────────────────────────

const mockOpen = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));

interface BusEvent {
  readonly type: string;
  readonly payload: unknown;
}
type Handler = (e: BusEvent) => void;

const handlers = new Map<string, Set<Handler>>();

function emit(type: string, payload: unknown): void {
  const e: BusEvent = { type, payload };
  for (const h of handlers.get(type) ?? []) h(e);
  for (const h of handlers.get("*") ?? []) h(e);
}

function resetBus(): void {
  handlers.clear();
}

vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    const set = handlers.get(type) ?? new Set<Handler>();
    handlers.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  },
  waitFor: (predicate: (e: BusEvent) => boolean) =>
    new Promise<BusEvent>((resolve) => {
      const wildcard = handlers.get("*") ?? new Set<Handler>();
      handlers.set("*", wildcard);
      const wrapped: Handler = (e) => {
        if (predicate(e)) {
          wildcard.delete(wrapped);
          resolve(e);
        }
      };
      wildcard.add(wrapped);
    }),
}));

const mockGitShipPreflight = vi.fn();
const mockGitStageCommit = vi.fn();
const mockGitPush = vi.fn();
const mockShipCompareUrl = vi.fn();

vi.mock("#lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/tauri")>();
  return {
    ...actual,
    gitShipPreflight: (...args: unknown[]) => mockGitShipPreflight(...args),
    gitStageCommit: (...args: unknown[]) => mockGitStageCommit(...args),
    gitPush: (...args: unknown[]) => mockGitPush(...args),
    shipCompareUrl: (...args: unknown[]) => mockShipCompareUrl(...args),
  };
});

// ── Fixtures ──────────────────────────────────────────

const WORKER_ID = "11111111-2222-3333-8444-555555555555";

function makePreflight(overrides: Partial<ShipPreflight> = {}): ShipPreflight {
  return {
    workerId: WORKER_ID,
    branch: "swarm/agent-abcd1234",
    baseBranch: "main",
    remote: "https://github.com/example/repo.git",
    host: "github.com",
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: ["src/main.ts"],
    untracked: [],
    skipped: [],
    diffStat: { filesChanged: 1, insertions: 5, deletions: 1 },
    ghAvailable: false,
    ghAuthed: false,
    canShip: true,
    blockers: [],
    ...overrides,
  };
}

function makeCommitOutcome(overrides: Partial<CommitOutcome> = {}): CommitOutcome {
  return {
    sha: "deadbeefcafef00d",
    filesChanged: 1,
    insertions: 5,
    deletions: 1,
    seqFrom: 0,
    seqTo: 10,
    skipped: [],
    ...overrides,
  };
}

function makePushOutcome(overrides: Partial<PushOutcome> = {}): PushOutcome {
  return { pushedRef: "origin/swarm/agent-abcd1234", ...overrides };
}

describe("useShip", () => {
  beforeEach(() => {
    resetBus();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetBus();
  });

  it("starts idle and transitions to previewing after a successful preflight, seeding the deterministic message", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());

    const { result } = renderHook(() => useShip(WORKER_ID));
    expect(result.current.state).toBe("idle");

    await act(async () => {
      await result.current.runPreflight();
    });

    expect(result.current.state).toBe("previewing");
    expect(result.current.preflight?.branch).toBe("swarm/agent-abcd1234");
    expect(result.current.message.length).toBeGreaterThan(0);
  });

  it("transitions to failed when preflight itself rejects", async () => {
    mockGitShipPreflight.mockRejectedValue(
      new ShipCommandError({ kind: "workerNotFound", message: "Worker Not Found.", remedy: null }),
    );

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error?.kind).toBe("workerNotFound");
  });

  it("commitOnly reaches settled with the commit sha, without calling push", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitOnly();
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result?.commitSha).toBe("deadbeefcafef00d");
    expect(mockGitPush).not.toHaveBeenCalled();
    // The final step of "Commit Only" — finalStep must be true.
    expect(mockGitStageCommit).toHaveBeenCalledWith(
      WORKER_ID,
      expect.any(String),
      expect.any(String),
      "all",
      true,
    );
  });

  it("commitAndPush stages with finalStep=false, then pushes with finalStep=true, and settles with the pushed ref", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockImplementation(async (workerId: string, shipId: string) => {
      // Emit the terminal receipt the same way the real backend does,
      // before the promise resolves.
      emit("ship_settled", { shipId, workerId });
      return makePushOutcome();
    });

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(mockGitStageCommit).toHaveBeenCalledWith(
      WORKER_ID,
      expect.any(String),
      expect.any(String),
      "all",
      false,
    );
    expect(mockGitPush).toHaveBeenCalledWith(
      WORKER_ID,
      expect.any(String),
      "deadbeefcafef00d",
      10,
      true,
    );
    expect(result.current.state).toBe("settled");
    expect(result.current.result?.pushedRef).toBe("origin/swarm/agent-abcd1234");
  });

  it("surfaces a push failure as a typed ShipError and never calls shipCompareUrl", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockRejectedValue(
      new ShipCommandError({
        kind: "pushRejected",
        message: "Push Rejected — Fetch And Rebase, Then Ship Again.",
        remedy: "fetchAndRebase",
      }),
    );

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitPushAndOpenCompare();
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error?.kind).toBe("pushRejected");
    expect(mockShipCompareUrl).not.toHaveBeenCalled();
  });

  it("collects live ship_progress rows scoped to this worker's shipId", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockImplementation(async (workerId: string, shipId: string) => {
      emit("ship_progress", {
        shipId,
        workerId,
        step: "staging",
        status: "ok",
        detail: "0 Skipped",
      });
      emit("ship_progress", { shipId, workerId, step: "commit", status: "ok", detail: "deadbeef" });
      // A progress event for a *different* shipId must never leak in.
      emit("ship_progress", {
        shipId: "unrelated-ship-id",
        workerId,
        step: "commit",
        status: "error",
        detail: "should not appear",
      });
      return makeCommitOutcome();
    });

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitOnly();
    });

    const steps = result.current.progress.map((r) => r.step);
    expect(steps).toEqual(["staging", "commit"]);
    expect(result.current.progress.every((r) => r.status !== "error")).toBe(true);
  });

  it("DIRECTIVE: the in-flight guard prevents a double-click from double-committing", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    let resolveCommit: (outcome: CommitOutcome) => void = () => {};
    mockGitStageCommit.mockImplementation(
      () =>
        new Promise<CommitOutcome>((resolve) => {
          resolveCommit = resolve;
        }),
    );

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });

    // Fire two commitOnly() calls back to back, synchronously, before
    // the first has any chance to resolve — simulates a double-click
    // landing before React re-renders to disable the button.
    let firstCall: Promise<void>;
    let secondCall: Promise<void>;
    act(() => {
      firstCall = result.current.commitOnly();
      secondCall = result.current.commitOnly();
    });

    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCommit(makeCommitOutcome());
      await firstCall;
      await secondCall;
    });

    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("settled");
  });

  it("reset() returns to idle and clears preflight/progress/error/result without touching message/mode", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    const seededMessage = result.current.message;
    await act(async () => {
      await result.current.commitOnly();
    });
    expect(result.current.state).toBe("settled");

    act(() => {
      result.current.reset();
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.preflight).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.message).toBe(seededMessage);
  });

  it("resets all transient state when workerId changes", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());

    const { result, rerender } = renderHook(({ id }) => useShip(id), {
      initialProps: { id: WORKER_ID },
    });
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitOnly();
    });
    expect(result.current.state).toBe("settled");

    const otherWorkerId = "99999999-8888-7777-6666-555555555555";
    rerender({ id: otherWorkerId });

    await rtlWaitFor(() => {
      expect(result.current.state).toBe("idle");
    });
    expect(result.current.preflight).toBeNull();
    expect(result.current.result).toBeNull();
  });
});
