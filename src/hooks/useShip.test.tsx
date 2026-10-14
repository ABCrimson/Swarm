import { openUrl } from "@tauri-apps/plugin-opener";
import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_SHIP_SNAPSHOT, type ShipSnapshot, shipReducer, useShip } from "#hooks/useShip";
import type { DomainEvent } from "#lib/event-bus";
import { ShipCommandError } from "#lib/tauri";
import type { CommitOutcome, PushOutcome, ShipContext, ShipPreflight } from "#store/types";

// ── Mocks ─────────────────────────────────────────────

type Handler = (e: DomainEvent) => void;

const handlers = new Map<string, Set<Handler>>();
let seq = 0;

function emit(type: string, payload: unknown): void {
  const e: DomainEvent = { seq: ++seq, ts: Date.now(), type, payload };
  for (const h of handlers.get(type) ?? []) h(e);
  for (const h of handlers.get("*") ?? []) h(e);
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

const mockGenerateCausalProse =
  vi.fn<(input: unknown, model: string, signal?: AbortSignal) => Promise<string>>();

vi.mock(import("#lib/ship-causal"), async (importOriginal) => ({
  ...(await importOriginal()),
  generateCausalProse: (...args) => mockGenerateCausalProse(...args),
}));

// ── Fixtures ──────────────────────────────────────────

const WORKER_ID = "11111111-2222-4333-8444-555555555555";
const COMPARE_URL = "https://github.com/example/repo/compare/main...swarm/agent-abcd1234";

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

function makeContext(overrides: Partial<ShipContext> = {}): ShipContext {
  return {
    workerId: WORKER_ID,
    seqFrom: 0,
    seqTo: 0,
    turns: [],
    commits: [],
    omittedTurnCount: 0,
    eventsTruncated: false,
    hasUncapturedWebviewActivity: false,
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

function pushRejectedError(): ShipCommandError {
  return new ShipCommandError({
    kind: "pushRejected",
    message: "Push Rejected — Fetch And Rebase, Then Ship Again.",
    remedy: "fetchAndRebase",
  });
}

/** Resolves a `(workerId, shipId, …)` mock after emitting that ship's `ship_settled` receipt. */
function settlesWith<T>(value: T) {
  return async (workerId: string, shipId: string): Promise<T> => {
    emit("ship_settled", { shipId, workerId });
    return value;
  };
}

async function renderPreviewing() {
  const hook = renderHook(() => useShip(WORKER_ID));
  await act(async () => {
    await hook.result.current.runPreflight();
  });
  return hook;
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mockShipContext.mockResolvedValue(makeContext());
});

afterEach(() => {
  handlers.clear();
  vi.useRealTimers();
});

describe("shipReducer", () => {
  it("seeds the deterministic message on the first preflight but never overwrites an edit", () => {
    const seeded = shipReducer(INITIAL_SHIP_SNAPSHOT, {
      type: "preflightLoaded",
      preflight: makePreflight(),
    });
    expect(seeded.state).toBe("previewing");
    expect(seeded.message).toMatch(/^feat: update src\/main\.ts/);

    const edited = shipReducer(seeded, { type: "messageChanged", message: "fix: my words" });
    const reloaded = shipReducer(edited, { type: "preflightLoaded", preflight: makePreflight() });
    expect(reloaded.message).toBe("fix: my words");
  });

  it("drops a refreshed preflight fetched for a mode the user has since left (B3)", () => {
    const previewing: ShipSnapshot = {
      ...INITIAL_SHIP_SNAPSHOT,
      state: "previewing",
      mode: "staged",
      preflight: makePreflight({ staged: ["a.ts"] }),
    };
    const stale = shipReducer(previewing, {
      type: "preflightRefreshed",
      preflight: makePreflight({ unstaged: ["b.ts"] }),
      mode: "all",
    });
    expect(stale).toBe(previewing);

    const current = shipReducer(previewing, {
      type: "preflightRefreshed",
      preflight: makePreflight({ staged: ["a.ts", "c.ts"] }),
      mode: "staged",
    });
    expect(current.preflight?.staged).toEqual(["a.ts", "c.ts"]);
  });

  it("keeps the previous prose when a regenerate fails", () => {
    const ready = shipReducer(INITIAL_SHIP_SNAPSHOT, { type: "proseReady", prose: "Kept." });
    const failed = shipReducer(ready, { type: "proseFailed", reason: "Network Connection Failed" });
    expect(failed.aiProse).toBe("Kept.");
    expect(failed.aiProseState).toBe("failed");
    expect(failed.aiProseError).toBe("Network Connection Failed");
    expect(shipReducer(failed, { type: "proseStarted" }).aiProseError).toBeNull();
  });

  it("reset returns to the initial snapshot but keeps message and mode", () => {
    const busy: ShipSnapshot = {
      ...INITIAL_SHIP_SNAPSHOT,
      state: "settled",
      message: "feat: x",
      mode: "staged",
      preflight: makePreflight(),
      result: { commitSha: "abc" },
      contextState: "ready",
      context: makeContext(),
    };
    expect(shipReducer(busy, { type: "reset" })).toEqual({
      ...INITIAL_SHIP_SNAPSHOT,
      message: "feat: x",
      mode: "staged",
    });
  });
});

describe("useShip", () => {
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
    expect(mockGitShipPreflight).toHaveBeenCalledWith(WORKER_ID, "all");
    expect(result.current.contextState).toBe("ready");
    expect(result.current.composedBody).toContain("## Causal Record");
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
    expect(result.current.error).toEqual({
      kind: "workerNotFound",
      message: "Worker Not Found.",
      remedy: null,
    });
  });

  it("reports a failed causal-record fetch as failed (not loading forever), and retryContext recovers", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockShipContext.mockRejectedValueOnce(new Error("event log unavailable"));

    const { result } = await renderPreviewing();
    expect(result.current.state).toBe("previewing");
    expect(result.current.contextState).toBe("failed");
    expect(result.current.context).toBeNull();
    expect(result.current.composedBody).toBeNull();

    await act(async () => {
      await result.current.retryContext();
    });

    expect(result.current.contextState).toBe("ready");
    expect(result.current.context).not.toBeNull();
  });

  it("commitOnly awaits its own ship_settled receipt and reaches settled with the commit sha, without calling push", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockImplementation(settlesWith(makeCommitOutcome()));

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitOnly();
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result?.commitSha).toBe("deadbeefcafef00d");
    expect(mockGitPush).not.toHaveBeenCalled();
    expect(mockGitStageCommit).toHaveBeenCalledWith(
      WORKER_ID,
      expect.any(String),
      result.current.message,
      "all",
      true,
    );
  });

  it("commitAndPush stages with finalStep=false, then pushes with finalStep=true, and settles with the pushed ref", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockImplementation(settlesWith(makePushOutcome()));

    const { result } = await renderPreviewing();
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
    expect(mockGitPush).toHaveBeenCalledWith(WORKER_ID, expect.any(String), true);
    expect(result.current.state).toBe("settled");
    expect(result.current.result?.pushedRef).toBe("origin/swarm/agent-abcd1234");
  });

  it("surfaces a push failure as the backend's typed ShipError (kind and remedy) and never calls shipCompareUrl", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockRejectedValue(pushRejectedError());

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitPushAndOpenCompare();
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error?.kind).toBe("pushRejected");
    expect(result.current.error?.remedy).toBe("fetchAndRebase");
    expect(mockShipCompareUrl).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("refreshes preflight after a failed action, so a retry after commit-landed-then-push-failed recovers (B2)", async () => {
    // Preflight #1: dirty tree, nothing unpushed. Preflight #2 (the
    // silent refresh after the failed push): the commit landed, so the
    // tree is clean and one commit is unpushed.
    mockGitShipPreflight
      .mockResolvedValueOnce(makePreflight({ ahead: 0 }))
      .mockResolvedValueOnce(makePreflight({ ahead: 1, unstaged: [] }));
    mockGitStageCommit
      .mockResolvedValueOnce(makeCommitOutcome())
      .mockRejectedValueOnce(nothingToCommitError());
    mockGitPush
      .mockRejectedValueOnce(pushRejectedError())
      .mockImplementationOnce(settlesWith(makePushOutcome()));

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error?.kind).toBe("pushRejected");
    expect(mockGitShipPreflight).toHaveBeenCalledTimes(2);
    expect(result.current.preflight?.ahead).toBe(1);

    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result?.pushedRef).toBe("origin/swarm/agent-abcd1234");
  });

  it("opens the compare URL only after settling, and an opener failure downgrades to a warning toast without flipping state to failed", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockResolvedValue(makePushOutcome());
    mockShipCompareUrl.mockImplementation(settlesWith(COMPARE_URL));
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no default browser configured"));

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitPushAndOpenCompare();
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result?.prUrl).toBe(COMPARE_URL);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(COMPARE_URL);
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(
      "Shipped, But Could Not Open The Compare Page: no default browser configured",
    );
  });

  it("sends the composed causal body (and the message title) to shipCompareUrl", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockResolvedValue(makePushOutcome());
    mockShipCompareUrl.mockImplementation(settlesWith(COMPARE_URL));

    const { result } = await renderPreviewing();
    act(() => {
      result.current.setMessage("feat: title line\n\nbody line");
    });
    await act(async () => {
      await result.current.commitPushAndOpenCompare();
    });

    expect(mockShipCompareUrl).toHaveBeenCalledWith(
      WORKER_ID,
      expect.any(String),
      "deadbeefcafef00d",
      "origin/swarm/agent-abcd1234",
      "feat: title line",
      expect.stringContaining("## Causal Record"),
    );
  });

  it("collects live ship_progress rows scoped to this worker's shipId, ignoring malformed payloads", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockImplementation(async (workerId: string, shipId: string) => {
      emit("ship_progress", {
        shipId,
        workerId,
        step: "staging",
        status: "ok",
        detail: "0 Skipped",
      });
      emit("ship_progress", { shipId, workerId, step: "commit", status: "ok", detail: null });
      // A different ship, and a payload that fails validation, never leak in.
      emit("ship_progress", { shipId: "other", workerId, step: "commit", status: "error" });
      emit("ship_progress", { shipId, workerId, step: "push", status: "exploded" });
      emit("ship_settled", { shipId, workerId });
      return makeCommitOutcome();
    });

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitOnly();
    });

    expect(result.current.progress).toEqual([
      { step: "staging", status: "ok", detail: "0 Skipped" },
      { step: "commit", status: "ok", detail: null },
    ]);
  });

  it("DIRECTIVE: the in-flight guard prevents a double-click from double-committing", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    const commit = Promise.withResolvers<CommitOutcome>();
    let capturedShipId = "";
    mockGitStageCommit.mockImplementation((_workerId: string, shipId: string) => {
      capturedShipId = shipId;
      return commit.promise;
    });

    const { result } = await renderPreviewing();

    // Two calls back to back, before the first can resolve — a
    // double-click landing before React re-renders to disable the button.
    let calls: Promise<void>[] = [];
    act(() => {
      calls = [result.current.commitOnly(), result.current.commitOnly()];
    });
    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      commit.resolve(makeCommitOutcome());
      emit("ship_settled", { shipId: capturedShipId, workerId: WORKER_ID });
      await Promise.all(calls);
    });

    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("settled");
  });

  it("reset() returns to idle and clears preflight/progress/error/result without touching message/mode", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockImplementation(settlesWith(makeCommitOutcome()));

    const { result } = await renderPreviewing();
    const seededMessage = result.current.message;
    await act(async () => {
      result.current.setMode("staged");
      await Promise.resolve();
    });
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
    expect(result.current.progress).toEqual([]);
    expect(result.current.message).toBe(seededMessage);
    expect(result.current.mode).toBe("staged");
  });

  // ── B1: explicit 30s receipt timeout (not the library's 5s default) ──

  it("DIRECTIVE (B1): a ship_settled receipt delivered at t≈6s (past waitFor's 5 s default, inside the 30 s budget) settles success, never a timeout failure", async () => {
    vi.useFakeTimers();
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    // gitPush resolves quickly, but the receipt EVENT arrives later on
    // its own transport path — the real-world race B1 describes.
    mockGitPush.mockResolvedValue(makePushOutcome());

    const { result } = await renderPreviewing();

    let actionPromise: Promise<void> = Promise.resolve();
    act(() => {
      actionPromise = result.current.commitAndPush();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const shipId = mockGitPush.mock.calls[0]?.[1] as string;
    expect(shipId).toBeTruthy();

    // Past waitFor's 5000ms default: a hook that relied on it would already show "failed".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5900);
    });
    expect(result.current.state).toBe("running");

    await act(async () => {
      emit("ship_settled", { shipId, workerId: WORKER_ID });
      await vi.advanceTimersByTimeAsync(0);
      await actionPromise;
    });

    expect(result.current.state).toBe("settled");
  });

  it("DIRECTIVE (B1): a push slower than 30 s whose receipt arrives with its response settles success", async () => {
    vi.useFakeTimers();
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    const push = Promise.withResolvers<ReturnType<typeof makePushOutcome>>();
    mockGitPush.mockReturnValue(push.promise);

    const { result } = await renderPreviewing();

    let actionPromise: Promise<void> = Promise.resolve();
    act(() => {
      actionPromise = result.current.commitAndPush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const shipId = mockGitPush.mock.calls[0]?.[1] as string;

    // The receipt clock must not run while the invoke is still in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(result.current.state).toBe("running");

    await act(async () => {
      emit("ship_settled", { shipId, workerId: WORKER_ID });
      push.resolve(makePushOutcome());
      await vi.advanceTimersByTimeAsync(0);
      await actionPromise;
    });

    expect(result.current.state).toBe("settled");
  });

  it("an ok reply whose receipt is still missing after 30 s is awaiting confirmation, then settles with the reply's result when the receipt lands", async () => {
    vi.useFakeTimers();
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockResolvedValue(makePushOutcome());

    const { result } = await renderPreviewing();

    let actionPromise: Promise<void> = Promise.resolve();
    act(() => {
      actionPromise = result.current.commitAndPush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    const shipId = mockGitPush.mock.calls[0]?.[1] as string;

    expect(result.current.state).toBe("running");
    expect(result.current.error).toBeNull();
    expect(result.current.progress.at(-1)).toMatchObject({
      step: "Awaiting Confirmation",
      status: "running",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
      emit("ship_settled", {
        shipId,
        workerId: WORKER_ID,
        commitSha: null,
        pushedRef: null,
        prUrl: null,
        status: "ok",
        error: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      await actionPromise;
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result).toEqual({
      commitSha: "deadbeefcafef00d",
      pushedRef: "origin/swarm/agent-abcd1234",
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("an ok reply with no receipt returns to idle at 30 s + rpcDeadlineMs of the final step, with a warning and never a failure", async () => {
    vi.useFakeTimers();
    const { rpcDeadlineMs } = await import("#lib/transport");
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockResolvedValue(makePushOutcome());

    const { result } = await renderPreviewing();

    let actionPromise: Promise<void> = Promise.resolve();
    act(() => {
      actionPromise = result.current.commitAndPush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000 + rpcDeadlineMs("git_push") - 1);
    });
    expect(result.current.state).toBe("running");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await actionPromise;
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.preflight).toBeNull();
    expect(result.current.error).toBeNull();
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("an ok reply followed by an error receipt fails with the receipt's error", async () => {
    vi.useFakeTimers();
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
    mockGitPush.mockResolvedValue(makePushOutcome());

    const { result } = await renderPreviewing();

    let actionPromise: Promise<void> = Promise.resolve();
    act(() => {
      actionPromise = result.current.commitAndPush();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    const shipId = mockGitPush.mock.calls[0]?.[1] as string;
    const rejected = pushRejectedError().shipError;

    await act(async () => {
      emit("ship_settled", {
        shipId,
        workerId: WORKER_ID,
        status: "error",
        error: rejected,
      });
      await vi.advanceTimersByTimeAsync(0);
      await actionPromise;
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error).toEqual(rejected);
  });

  // ── B2: NothingToCommit recovery when there's already unpushed work ──

  it("DIRECTIVE (B2): commit-only, then commitAndPush on a clean tree with ahead=1 → push runs and settles success (no re-staging)", async () => {
    mockGitShipPreflight
      .mockResolvedValueOnce(makePreflight({ ahead: 0 }))
      .mockResolvedValueOnce(makePreflight({ ahead: 1, staged: [], unstaged: [], untracked: [] }));
    mockGitStageCommit
      .mockImplementationOnce(settlesWith(makeCommitOutcome()))
      .mockRejectedValueOnce(nothingToCommitError());
    mockGitPush.mockImplementation(settlesWith(makePushOutcome()));

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitOnly();
    });
    expect(result.current.state).toBe("settled");
    expect(mockGitPush).not.toHaveBeenCalled();

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
    // No fresh commit on the second ship — the sha comes from the push.
    expect(result.current.result?.commitSha).toBe("deadbeefcafef00d");
  });

  it("DIRECTIVE (B2): does NOT recover from NothingToCommit when ahead is 0 — genuinely nothing to ship", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight({ ahead: 0 }));
    mockGitStageCommit.mockRejectedValue(nothingToCommitError());

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error?.kind).toBe("nothingToCommit");
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  // ── AI prose ──

  it("regenerateProse stores the generated prose and folds it into the composed body", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGenerateCausalProse.mockResolvedValue("Tightened the preflight.");

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.regenerateProse();
    });

    expect(result.current.aiProseState).toBe("ready");
    expect(result.current.aiProse).toBe("Tightened the preflight.");
    expect(result.current.composedBody).toContain("Tightened the preflight.");
  });

  it("aborts an in-flight prose stream when the flow unmounts (a worker switch)", async () => {
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    const pending = Promise.withResolvers<string>();
    mockGenerateCausalProse.mockReturnValue(pending.promise);

    const { result, unmount } = await renderPreviewing();
    act(() => {
      void result.current.regenerateProse();
    });
    const signal = mockGenerateCausalProse.mock.lastCall?.[2];
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
    pending.resolve("");
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

    const { result } = await renderPreviewing();
    expect(mockGitShipPreflight).toHaveBeenNthCalledWith(1, WORKER_ID, "all");

    await act(async () => {
      result.current.setMode("staged");
      await Promise.resolve();
    });

    expect(mockGitShipPreflight).toHaveBeenNthCalledWith(2, WORKER_ID, "staged");
    expect(result.current.mode).toBe("staged");
    expect(result.current.preflight?.skipped).toHaveLength(1);
  });

  it("toasts and keeps the previous preview when a mode-switch refetch fails", async () => {
    mockGitShipPreflight
      .mockResolvedValueOnce(makePreflight())
      .mockRejectedValueOnce(new Error("boom"));

    const { result } = await renderPreviewing();
    const before = result.current.preflight;

    await act(async () => {
      result.current.setMode("staged");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.error).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toMatch(/^Could Not Refresh The Preview:/);
    expect(result.current.preflight).toBe(before);
  });

  it("keeps the action's error as the only message when the refetch after a failed action also fails", async () => {
    mockGitShipPreflight
      .mockResolvedValueOnce(makePreflight())
      .mockRejectedValueOnce(new Error("boom"));
    mockGitStageCommit.mockResolvedValueOnce(makeCommitOutcome());
    mockGitPush.mockRejectedValueOnce(pushRejectedError());

    const { result } = await renderPreviewing();
    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(result.current.state).toBe("failed");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

// ── A lost reply is unknown, never failed (M0.6) ──────

describe("shipReducer: actionInterrupted", () => {
  it("returns a running flow to idle like reset, keeping message and mode but dropping the stale preview", () => {
    const running: ShipSnapshot = {
      ...INITIAL_SHIP_SNAPSHOT,
      state: "running",
      preflight: makePreflight(),
      message: "feat: x",
      progress: [{ step: "Awaiting Confirmation", status: "running", detail: null }],
    };
    expect(shipReducer(running, { type: "actionInterrupted" })).toEqual({
      ...INITIAL_SHIP_SNAPSHOT,
      message: "feat: x",
      mode: "all",
    });
  });
});

describe("useShip: a lost reply over the daemon", () => {
  /** Starts `start` and lets its first steps run; returns the action promise and the shipId of the first `call`. */
  async function startShip(
    start: () => Promise<void>,
    call: { mock: { calls: unknown[][] } },
  ): Promise<{ action: Promise<void>; shipId: string }> {
    let action: Promise<void> = Promise.resolve();
    act(() => {
      action = start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    return { action, shipId: call.mock.calls[0]?.[1] as string };
  }

  function receipt(shipId: string, fields: Record<string, unknown>) {
    return {
      shipId,
      workerId: WORKER_ID,
      commitSha: null,
      pushedRef: null,
      prUrl: null,
      status: "ok",
      error: null,
      ...fields,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockGitShipPreflight.mockResolvedValue(makePreflight());
    mockGitStageCommit.mockResolvedValue(makeCommitOutcome());
  });

  it("S1: keeps a push whose reply was lost running, then settles from the replayed receipt", async () => {
    const { RpcConnectionLostError } = await import("#lib/transport");
    mockGitPush.mockRejectedValue(new RpcConnectionLostError("git_push"));
    const { result } = await renderPreviewing();
    const { action, shipId } = await startShip(() => result.current.commitAndPush(), mockGitPush);

    expect(result.current.state).toBe("running");
    expect(result.current.error).toBeNull();
    expect(result.current.progress.at(-1)).toMatchObject({
      step: "Awaiting Confirmation",
      status: "running",
    });

    await act(async () => {
      emit(
        "ship_settled",
        receipt(shipId, { commitSha: "c0ffee", pushedRef: "origin/swarm/x", status: "ok" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      await action;
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result).toEqual({ commitSha: "c0ffee", pushedRef: "origin/swarm/x" });
    expect(result.current.progress.at(-1)).toMatchObject({
      step: "Awaiting Confirmation",
      status: "ok",
    });
  });

  it("S1: a receipt recorded before the reply was declared lost settles at once", async () => {
    const { RpcConnectionLostError } = await import("#lib/transport");
    const lost = Promise.withResolvers<never>();
    mockGitPush.mockReturnValue(lost.promise);
    const { result } = await renderPreviewing();
    const { action, shipId } = await startShip(() => result.current.commitAndPush(), mockGitPush);

    await act(async () => {
      emit("ship_settled", receipt(shipId, { pushedRef: "origin/swarm/x" }));
      lost.reject(new RpcConnectionLostError("git_push"));
      await vi.advanceTimersByTimeAsync(0);
      await action;
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result).toEqual({
      commitSha: "deadbeefcafef00d",
      pushedRef: "origin/swarm/x",
    });
  });

  it("a real failure still refreshes the preview quietly", async () => {
    mockGitPush.mockRejectedValue(pushRejectedError());
    const { result } = await renderPreviewing();
    const preflightCalls = mockGitShipPreflight.mock.calls.length;
    const { action } = await startShip(() => result.current.commitAndPush(), mockGitPush);
    await act(async () => {
      await action;
    });

    expect(result.current.state).toBe("failed");
    expect(mockGitShipPreflight.mock.calls.length).toBeGreaterThan(preflightCalls);
  });

  it("S2: fails with the receipt's error when the replayed receipt says the push failed", async () => {
    const { RpcConnectionLostError } = await import("#lib/transport");
    mockGitPush.mockRejectedValue(new RpcConnectionLostError("git_push"));
    const { result } = await renderPreviewing();
    const { action, shipId } = await startShip(() => result.current.commitAndPush(), mockGitPush);
    const rejected = pushRejectedError().shipError;
    const preflightCalls = mockGitShipPreflight.mock.calls.length;

    await act(async () => {
      emit("ship_settled", receipt(shipId, { status: "error", error: rejected }));
      await vi.advanceTimersByTimeAsync(0);
      await action;
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error).toEqual(rejected);
    expect(mockGitShipPreflight.mock.calls.length).toBeGreaterThan(preflightCalls);
  });

  it("S3: a lost commit reply with a commit ok row and no receipt returns to idle (the panel reloads the preview), and a second ship meanwhile does not re-commit", async () => {
    const { RpcTimeoutError } = await import("#lib/transport");
    mockGitStageCommit.mockRejectedValue(new RpcTimeoutError("git_stage_commit", 630_000));
    const { result } = await renderPreviewing();
    const { action, shipId } = await startShip(
      () => result.current.commitAndPush(),
      mockGitStageCommit,
    );
    const preflightCalls = mockGitShipPreflight.mock.calls.length;

    await act(async () => {
      emit("ship_progress", { shipId, workerId: WORKER_ID, step: "commit", status: "ok" });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.state).toBe("running");

    await act(async () => {
      await result.current.commitAndPush();
    });
    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      await action;
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.preflight).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.progress).toEqual([]);
    // ShipPanel reloads the preview on the transition into idle; the hook
    // itself must not quietly refetch and then claim the preview is fresh.
    expect(mockGitShipPreflight.mock.calls.length).toBe(preflightCalls);
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.warning).mock.calls[0]?.[0]).not.toMatch(/Is Refreshed/);
    expect(mockGitPush).not.toHaveBeenCalled();
  });

  it("S3: the receipt following the lost call's terminal row still settles the flow", async () => {
    const { RpcTimeoutError } = await import("#lib/transport");
    mockGitPush.mockRejectedValue(new RpcTimeoutError("git_push", 630_000));
    const { result } = await renderPreviewing();
    const { action, shipId } = await startShip(() => result.current.commitAndPush(), mockGitPush);

    await act(async () => {
      emit("ship_progress", { shipId, workerId: WORKER_ID, step: "push", status: "ok" });
      await vi.advanceTimersByTimeAsync(5_000);
      emit("ship_settled", receipt(shipId, { pushedRef: "origin/swarm/x" }));
      await vi.advanceTimersByTimeAsync(0);
      await action;
    });

    expect(result.current.state).toBe("settled");
  });

  it("S4: a lost reply with no events stays running until rpcDeadlineMs, then returns to idle, never failed", async () => {
    const { RpcConnectionLostError, rpcDeadlineMs } = await import("#lib/transport");
    mockGitPush.mockRejectedValue(new RpcConnectionLostError("git_push"));
    const { result } = await renderPreviewing();
    const { action } = await startShip(() => result.current.commitAndPush(), mockGitPush);
    const preflightCalls = mockGitShipPreflight.mock.calls.length;
    const deadline = rpcDeadlineMs("git_push");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(deadline - 1);
    });
    expect(result.current.state).toBe("running");
    expect(mockGitShipPreflight.mock.calls.length).toBe(preflightCalls);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await action;
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.preflight).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockGitShipPreflight.mock.calls.length).toBe(preflightCalls);
    expect(toast.warning).toHaveBeenCalledOnce();
  });

  it("S5: a healthy 45-second push settles, so the hook imposes no 30 s limit of its own", async () => {
    const push = Promise.withResolvers<ReturnType<typeof makePushOutcome>>();
    mockGitPush.mockReturnValue(push.promise);
    const { result } = await renderPreviewing();
    const { action, shipId } = await startShip(() => result.current.commitAndPush(), mockGitPush);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(result.current.state).toBe("running");
    expect(result.current.progress.some((row) => row.step === "Awaiting Confirmation")).toBe(false);

    await act(async () => {
      emit("ship_settled", receipt(shipId, { pushedRef: "origin/swarm/agent-abcd1234" }));
      push.resolve(makePushOutcome());
      await vi.advanceTimersByTimeAsync(0);
      await action;
    });

    expect(result.current.state).toBe("settled");
    expect(result.current.result).toEqual({
      commitSha: "deadbeefcafef00d",
      pushedRef: "origin/swarm/agent-abcd1234",
    });
  });

  it("F3: a ship started while a lost reply is unreconciled says so instead of doing nothing", async () => {
    const { RpcConnectionLostError, rpcDeadlineMs } = await import("#lib/transport");
    mockGitPush.mockRejectedValue(new RpcConnectionLostError("git_push"));
    const { result } = await renderPreviewing();
    const { action } = await startShip(() => result.current.commitAndPush(), mockGitPush);

    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(toast.info).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.info).mock.calls[0]?.[0]).toMatch(/Awaiting/);
    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(rpcDeadlineMs("git_push"));
      await action;
    });
  });

  it("F3: a plain double-click on a running ship stays silent", async () => {
    const push = Promise.withResolvers<ReturnType<typeof makePushOutcome>>();
    mockGitPush.mockReturnValue(push.promise);
    const { result } = await renderPreviewing();
    const { action, shipId } = await startShip(() => result.current.commitAndPush(), mockGitPush);

    await act(async () => {
      await result.current.commitAndPush();
    });

    expect(toast.info).not.toHaveBeenCalled();
    expect(mockGitStageCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      emit("ship_settled", receipt(shipId, {}));
      push.resolve(makePushOutcome());
      await vi.advanceTimersByTimeAsync(0);
      await action;
    });
  });

  it("a command's own error is still a real failure, not an unknown outcome", async () => {
    mockGitPush.mockRejectedValue(pushRejectedError());
    const { result } = await renderPreviewing();
    const { action } = await startShip(() => result.current.commitAndPush(), mockGitPush);
    await act(async () => {
      await action;
    });

    expect(result.current.state).toBe("failed");
    expect(result.current.error?.kind).toBe("pushRejected");
  });
});
