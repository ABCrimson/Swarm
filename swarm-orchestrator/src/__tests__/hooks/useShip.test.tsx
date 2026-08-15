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

const mockToastWarning = vi.fn();
vi.mock("sonner", () => ({
  toast: { warning: (...args: unknown[]) => mockToastWarning(...args) },
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

// DIRECTIVE (B1): this mock's `waitFor` mirrors the real
// `#lib/event-bus` implementation's timeout behavior (a real
// `setTimeout` that rejects) rather than waiting forever — the
// original version of this mock had no timer at all, which is exactly
// why the suite never caught useShip arming `waitForSettled` with the
// library default (5000ms) instead of an explicit 30000ms budget.
vi.mock("#lib/event-bus", () => ({
  onEvent: (type: string, handler: Handler) => {
    const set = handlers.get(type) ?? new Set<Handler>();
    handlers.set(type, set);
    set.add(handler);
    return () => set.delete(handler);
  },
  waitFor: (predicate: (e: BusEvent) => boolean, timeoutMs = 5000) =>
    new Promise<BusEvent>((resolve, reject) => {
      const wildcard = handlers.get("*") ?? new Set<Handler>();
      handlers.set("*", wildcard);
      const timer = setTimeout(() => {
        wildcard.delete(wrapped);
        reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const wrapped: Handler = (e) => {
        if (predicate(e)) {
          clearTimeout(timer);
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
// Resolves to an empty-but-valid ShipContext by default so the
// fire-and-forget `fetchContext` call `runPreflight` makes settles
// promptly and deterministically instead of falling through to the real
// `invoke()` (no Tauri bridge in jsdom) — see `fetchContext`'s own doc
// for why its failure mode is silent (never a ship error), which this
// default keeps this whole suite from ever having to think about.
const mockShipContext = vi.fn().mockResolvedValue({
  workerId: "11111111-2222-3333-8444-555555555555",
  seqFrom: 0,
  seqTo: 0,
  turns: [],
  commits: [],
  omittedTurnCount: 0,
});

vi.mock("#lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/tauri")>();
  return {
    ...actual,
    gitShipPreflight: (...args: unknown[]) => mockGitShipPreflight(...args),
    gitStageCommit: (...args: unknown[]) => mockGitStageCommit(...args),
    gitPush: (...args: unknown[]) => mockGitPush(...args),
    shipCompareUrl: (...args: unknown[]) => mockShipCompareUrl(...args),
    shipContext: (...args: unknown[]) => mockShipContext(...args),
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
  return { pushedRef: "origin/swarm/agent-abcd1234", sha: "deadbeefcafef00d", ...overrides };
}

function nothingToCommitError(): ShipCommandError {
  return new ShipCommandError({
    kind: "nothingToCommit",
    message: "Nothing To Commit — Every Changed File Was Skipped Or There Are No Changes.",
    remedy: null,
  });
}

describe("useShip", () => {
  beforeEach(() => {
    resetBus();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetBus();
    vi.useRealTimers();
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
    // Defaults to "all" mode.
    expect(mockGitShipPreflight).toHaveBeenCalledWith(WORKER_ID, "all");
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

  it("commitOnly awaits its own ship_settled receipt and reaches settled with the commit sha, without calling push", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockImplementation(async (workerId: string, shipId: string) => {
      emit("ship_settled", { shipId, workerId });
      return makeCommitOutcome();
    });

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

  it("commitAndPush stages with finalStep=false, then pushes with finalStep=true (no commitSha/seqTo params), and settles with the pushed ref", async () => {
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
    // gitPush no longer takes commitSha/seqTo — just (workerId, shipId, finalStep).
    expect(mockGitPush).toHaveBeenCalledWith(WORKER_ID, expect.any(String), true);
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
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("opens the compare URL only after settling, and a shell-open failure downgrades to a warning toast without flipping state to failed (nit)", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockResolvedValue(makePushOutcome());
    mockShipCompareUrl.mockImplementation(async (workerId: string, shipId: string) => {
      emit("ship_settled", { shipId, workerId });
      return "https://github.com/example/repo/compare/main...swarm/agent-abcd1234";
    });
    mockOpen.mockRejectedValueOnce(new Error("no default browser configured"));

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitPushAndOpenCompare();
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result?.prUrl).toBe(
      "https://github.com/example/repo/compare/main...swarm/agent-abcd1234",
    );
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
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
      emit("ship_settled", { shipId, workerId });
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
    let capturedShipId = "";
    mockGitStageCommit.mockImplementation(
      (_workerId: string, shipId: string) =>
        new Promise<CommitOutcome>((resolve) => {
          capturedShipId = shipId;
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
      // commitOnly now awaits its own ship_settled receipt (nit fix) —
      // the mocked backend must deliver it for the call to ever
      // resolve, same as the real one does.
      emit("ship_settled", { shipId: capturedShipId, workerId: WORKER_ID });
      await firstCall;
      await secondCall;
    });

    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);
  });

  it("reset() returns to idle and clears preflight/progress/error/result without touching message/mode", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockImplementation(async (workerId: string, shipId: string) => {
      emit("ship_settled", { shipId, workerId });
      return makeCommitOutcome();
    });

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
    mockGitStageCommit.mockImplementation(async (workerId: string, shipId: string) => {
      emit("ship_settled", { shipId, workerId });
      return makeCommitOutcome();
    });

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

  // ── B1: explicit 30s receipt timeout (not the library's 5s default) ──

  it("DIRECTIVE (B1): a ship_settled receipt delivered at t≈8s must settle success, never a timeout failure — proves the 30s budget, not the library's 5s default, is in effect", async () => {
    vi.useFakeTimers();
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    // gitPush resolves quickly, but the backend's ship_settled EVENT
    // arrives independently, later — exactly the real-world race B1
    // describes (the invoke() response and the event are two separate
    // transport paths).
    mockGitPush.mockResolvedValue(makePushOutcome());

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });

    let actionPromise: Promise<void> = Promise.resolve();
    act(() => {
      actionPromise = result.current.commitAndPush();
    });

    // Let the mocked stage/push promises resolve and the settled
    // listener get armed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const shipId = mockGitPush.mock.calls[0]?.[1] as string;
    expect(shipId).toBeTruthy();

    // Past the OLD 5000ms default — if useShip still relied on
    // waitFor's library default, the promise would already have
    // rejected with a timeout and the hook would show "failed" here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5900);
    });
    expect(result.current.state).toBe("running");

    // Deliver the receipt at t≈8s — well within the real 30s budget.
    act(() => {
      emit("ship_settled", { shipId, workerId: WORKER_ID });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await actionPromise;
    });

    expect(result.current.state).toBe("settled");
  });

  // ── B2: NothingToCommit recovery when there's already unpushed work ──

  it("DIRECTIVE (B2): commit-only, then commitAndPush on a clean tree with ahead=1 → push runs and settles success (no re-staging)", async () => {
    mockGitShipPreflight
      .mockResolvedValueOnce(makePreflight({ ahead: 0 }))
      .mockResolvedValueOnce(makePreflight({ ahead: 1, staged: [], unstaged: [], untracked: [] }));
    mockGitStageCommit
      .mockImplementationOnce(async (workerId: string, shipId: string) => {
        emit("ship_settled", { shipId, workerId });
        return makeCommitOutcome();
      })
      .mockRejectedValueOnce(nothingToCommitError());
    mockGitPush.mockImplementation(async (workerId: string, shipId: string) => {
      emit("ship_settled", { shipId, workerId });
      return makePushOutcome();
    });

    const { result } = renderHook(() => useShip(WORKER_ID));

    // First ship: Commit Only.
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitOnly();
    });
    expect(result.current.state).toBe("settled");
    expect(mockGitPush).not.toHaveBeenCalled();

    // Second ship attempt on the same (now clean, ahead=1) worktree.
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.runPreflight();
    });
    expect(result.current.preflight?.ahead).toBe(1);

    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(mockGitStageCommit).toHaveBeenCalledTimes(2);
    expect(mockGitPush).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("settled");
    expect(result.current.result?.pushedRef).toBe("origin/swarm/agent-abcd1234");
    // No fresh commit was made on the second ship — the sha in the
    // result must come from the push's own resolved sha.
    expect(result.current.result?.commitSha).toBe("deadbeefcafef00d");
  });

  it("DIRECTIVE (B2): does NOT recover from NothingToCommit when ahead is 0 — genuinely nothing to ship", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight({ ahead: 0 }));
    mockGitStageCommit.mockRejectedValue(nothingToCommitError());

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error?.kind).toBe("nothingToCommit");
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  // ── B3: mode toggle refetches preflight for the new mode ─────────

  it("DIRECTIVE (B3): switching staging mode while previewing refetches preflight for that mode", async () => {
    mockGitShipPreflight
      .mockResolvedValueOnce(makePreflight({ staged: ["a.env"] }))
      .mockResolvedValueOnce(
        makePreflight({
          staged: ["a.env"],
          skipped: [{ path: "a.env", reason: "Skipped — Looks Like A Credential" }],
        }),
      );

    const { result } = renderHook(() => useShip(WORKER_ID));
    await act(async () => {
      await result.current.runPreflight();
    });
    expect(mockGitShipPreflight).toHaveBeenNthCalledWith(1, WORKER_ID, "all");

    await act(async () => {
      result.current.setMode("staged");
      await Promise.resolve();
    });

    expect(mockGitShipPreflight).toHaveBeenNthCalledWith(2, WORKER_ID, "staged");
    expect(result.current.mode).toBe("staged");
    expect(result.current.preflight?.skipped).toHaveLength(1);
  });
});
