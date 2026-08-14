import { open } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { onEvent, waitFor } from "#lib/event-bus";
import { generateCommitMessage } from "#lib/ship-message";
import {
  gitPush,
  gitShipPreflight,
  gitStageCommit,
  ShipCommandError,
  shipCompareUrl,
} from "#lib/tauri";
import type { ShipError, ShipPreflight, StagingMode } from "#store/types";

/** Ship state machine states — see the module doc for transitions. */
export type ShipState = "idle" | "preflighting" | "previewing" | "running" | "settled" | "failed";

/** One row of the live progress checklist, fed by `ship_progress` events. */
export interface ShipProgressRow {
  readonly step: string;
  readonly status: "running" | "ok" | "error";
  readonly detail: string | null;
}

/** Terminal outcome fields, populated as each step of the chosen action completes. */
export interface ShipResult {
  readonly commitSha?: string;
  readonly pushedRef?: string;
  readonly prUrl?: string;
}

interface UseShipReturn {
  readonly state: ShipState;
  readonly preflight: ShipPreflight | null;
  readonly message: string;
  readonly setMessage: (message: string) => void;
  readonly mode: StagingMode;
  /** Changes the staging mode and, when a preview is already showing, refetches preflight for the new mode (B3: the skipped/diffStat preview must be accurate per mode, not just per "all"). */
  readonly setMode: (mode: StagingMode) => void;
  readonly progress: readonly ShipProgressRow[];
  readonly error: ShipError | null;
  readonly result: ShipResult | null;
  /** Runs preflight and (on success) seeds `message` with the deterministic template, moving to `"previewing"`. */
  readonly runPreflight: () => Promise<void>;
  readonly commitOnly: () => Promise<void>;
  readonly commitAndPush: () => Promise<void>;
  readonly commitPushAndOpenCompare: () => Promise<void>;
  /** Returns to `"idle"` and clears all transient state — does not touch `message`/`mode`. */
  readonly reset: () => void;
}

/**
 * Module-level in-flight guard, keyed by `workerId` — checked
 * synchronously (no `await` between the check and the add) at the top
 * of every action, so a double-click on the same worker's Ship button
 * can never start two overlapping commits, regardless of React
 * re-render timing. Deliberately module-level rather than component
 * state: two mounts of the same worker's `ShipPanel` (unlikely today,
 * but not impossible with a future split-view) must share one guard.
 */
const inFlightWorkers = new Set<string>();

interface ShipProgressEventPayload {
  readonly shipId: string;
  readonly workerId: string;
  readonly step: string;
  readonly status: "running" | "ok" | "error";
  readonly detail: string | null;
}

interface ShipSettledEventPayload {
  readonly shipId: string;
  readonly workerId: string;
}

/**
 * DIRECTIVE (B1): the backend's own git budget for a mutating call
 * (`CREATE_TIMEOUT` in `git/cli.rs`) is 20s — a real push legitimately
 * taking anywhere from 5-20s (a slow remote, a large object) must
 * never be reported as "failed" by a frontend timeout that fires
 * first. 30s = the backend's own budget + margin, always passed
 * explicitly rather than relying on `waitFor`'s 5s default.
 */
const SHIP_SETTLED_TIMEOUT_MS = 30_000;

/**
 * Ship state machine: idle → preflighting → previewing → running →
 * settled | failed. One instance is scoped to one worker (`workerId`)
 * — see `components/ship/ShipPanel.tsx`, its sole consumer.
 */
export function useShip(workerId: string): UseShipReturn {
  const [state, setState] = useState<ShipState>("idle");
  const [preflight, setPreflight] = useState<ShipPreflight | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setModeState] = useState<StagingMode>("all");
  const [progress, setProgress] = useState<readonly ShipProgressRow[]>([]);
  const [error, setError] = useState<ShipError | null>(null);
  const [result, setResult] = useState<ShipResult | null>(null);

  // Reset all per-worker transient state when the panel switches to a
  // different worker — a stale preview/progress from the previously
  // selected worker must never bleed into the newly selected one.
  const lastWorkerId = useRef(workerId);
  useEffect(() => {
    if (lastWorkerId.current !== workerId) {
      lastWorkerId.current = workerId;
      setState("idle");
      setPreflight(null);
      setMessage("");
      setModeState("all");
      setProgress([]);
      setError(null);
      setResult(null);
    }
  }, [workerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on workerId only — mode is read fresh via closure at call time but must not itself be a dependency (that would redefine runPreflight's identity on every mode change, which ShipPanel's effect treats as "re-run preflight"; setMode below already handles a mode-change refresh directly, without going through this callback).
  const runPreflight = useCallback(async () => {
    setState("preflighting");
    setError(null);
    try {
      const result = await gitShipPreflight(workerId, mode);
      setPreflight(result);
      setMessage((prev) => (prev.trim().length > 0 ? prev : generateCommitMessage(result)));
      setState("previewing");
    } catch (err) {
      setError(toShipError(err));
      setState("failed");
    }
  }, [workerId]);

  /**
   * DIRECTIVE (B3): the deny-list/diffStat preview must reflect the
   * mode actually about to be committed, not always "all" — switching
   * to "staged" (only offered when preflight detects a pre-staged
   * index) refetches preflight for that mode rather than leaving the
   * "all"-mode preview visible.
   */
  const setMode = useCallback(
    (newMode: StagingMode) => {
      setModeState(newMode);
      if (state !== "previewing" && state !== "failed") return;
      void (async () => {
        try {
          const refreshed = await gitShipPreflight(workerId, newMode);
          setPreflight(refreshed);
        } catch {
          // A mode-toggle refresh failing is not itself a ship
          // failure — keep showing the previous (still-valid) preview
          // rather than clobbering the UI over a transient refetch
          // error.
        }
      })();
    },
    [workerId, state],
  );

  /** Shared body for every mutating action — the in-flight guard, event subscription, and terminal state handling live here once. Returns the final `ShipResult` on success (for a caller that needs to act *after* settling, e.g. opening a URL — see the nit on `commitPushAndOpenCompare`), or `undefined` on failure. */
  const runAction = useCallback(
    async (body: (shipId: string) => Promise<ShipResult>): Promise<ShipResult | undefined> => {
      if (inFlightWorkers.has(workerId)) return undefined;
      inFlightWorkers.add(workerId);

      const shipId = crypto.randomUUID();
      setState("running");
      setProgress([]);
      setError(null);
      setResult(null);

      const offProgress = onEvent("ship_progress", (e) => {
        const p = e.payload as ShipProgressEventPayload;
        if (p.shipId !== shipId || p.workerId !== workerId) return;
        setProgress((prev) => [...prev, { step: p.step, status: p.status, detail: p.detail }]);
      });

      try {
        const finalResult = await body(shipId);
        setResult(finalResult);
        setState("settled");
        return finalResult;
      } catch (err) {
        setError(toShipError(err));
        setState("failed");
        return undefined;
      } finally {
        offProgress();
        inFlightWorkers.delete(workerId);
      }
    },
    [workerId],
  );

  const commitOnly = useCallback(async () => {
    await runAction(async (shipId) => {
      // Nit: commitOnly awaits its own receipt too, same 30s timeout
      // discipline as the multi-step actions below — the backend
      // emits ship_settled for a successful finalStep=true commit.
      const settled = armSettledWait(shipId);
      const commit = await gitStageCommit(workerId, shipId, message, mode, true);
      await settled;
      return { commitSha: commit.sha };
    });
  }, [runAction, workerId, message, mode]);

  const commitAndPush = useCallback(async () => {
    await runAction(async (shipId) => {
      const commitSha = await stageOrRecoverFromNothingToCommit(
        workerId,
        shipId,
        message,
        mode,
        preflight,
      );
      // Registered *before* triggering the call whose own completion
      // races the event: the backend can emit ship_settled at any
      // point during the push, including before its invoke() promise
      // resolves, so the listener must already be armed when that
      // happens rather than being set up only after gitPush returns.
      const settled = armSettledWait(shipId);
      const push = await gitPush(workerId, shipId, true);
      await settled;
      return { commitSha: commitSha ?? push.sha, pushedRef: push.pushedRef };
    });
  }, [runAction, workerId, message, mode, preflight]);

  const commitPushAndOpenCompare = useCallback(async () => {
    const outcome = await runAction(async (shipId) => {
      const commitSha = await stageOrRecoverFromNothingToCommit(
        workerId,
        shipId,
        message,
        mode,
        preflight,
      );
      const push = await gitPush(workerId, shipId, false);
      const [title, ...bodyLines] = message.split("\n");
      // Same ordering rule as commitAndPush above — arm the listener
      // before the call that might trigger it.
      const settled = armSettledWait(shipId);
      const url = await shipCompareUrl(
        workerId,
        shipId,
        commitSha ?? push.sha,
        push.pushedRef,
        title ?? message,
        bodyLines.join("\n").trim(),
      );
      await settled;
      return { commitSha: commitSha ?? push.sha, pushedRef: push.pushedRef, prUrl: url };
    });
    // Nit: opening the URL happens *outside* runAction's try/catch —
    // commit + push + compare-URL generation already fully succeeded
    // by this point (the state is already "settled"); a shell-open
    // failure (e.g. no default browser configured) downgrades to a
    // warning toast, it never flips a successful ship back to
    // "failed".
    if (outcome?.prUrl != null) {
      try {
        await open(outcome.prUrl);
      } catch (err) {
        toast.warning(
          `Shipped, But Could Not Open The Compare Page: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }, [runAction, workerId, message, mode, preflight]);

  const reset = useCallback(() => {
    setState("idle");
    setPreflight(null);
    setProgress([]);
    setError(null);
    setResult(null);
  }, []);

  return {
    state,
    preflight,
    message,
    setMessage,
    mode,
    setMode,
    progress,
    error,
    result,
    runPreflight,
    commitOnly,
    commitAndPush,
    commitPushAndOpenCompare,
    reset,
  };
}

/**
 * DIRECTIVE (B2): a `gitStageCommit` call that fails with
 * `nothingToCommit` is not automatically a ship failure — a worker can
 * have already-committed, unpushed work (e.g. from an earlier "Commit
 * Only"), which `ShipPreflight.ahead > 0` reports. In that case, this
 * returns `null` (meaning "nothing new was staged, push whatever
 * HEAD already is") instead of re-throwing, so `commitAndPush`/
 * `commitPushAndOpenCompare` can proceed straight to `gitPush` — which
 * resolves its own sha server-side (see `gitPush`'s doc) and needs no
 * `commitSha` from this call at all. Any other error (including
 * `nothingToCommit` when `ahead` is `0` — genuinely nothing to ship)
 * propagates normally.
 */
async function stageOrRecoverFromNothingToCommit(
  workerId: string,
  shipId: string,
  message: string,
  mode: StagingMode,
  preflight: ShipPreflight | null,
): Promise<string | null> {
  try {
    const commit = await gitStageCommit(workerId, shipId, message, mode, false);
    return commit.sha;
  } catch (err) {
    const shipErr = toShipError(err);
    if (shipErr.kind === "nothingToCommit" && (preflight?.ahead ?? 0) > 0) {
      return null;
    }
    throw err;
  }
}

/**
 * Arms a `waitFor("ship_settled", shipId)` listener and returns it
 * immediately, with a no-op `.catch()` already attached so an early
 * rejection (the backend settles before the caller gets around to
 * `await`ing the *returned* promise, or the 30s timeout fires) can
 * never surface as a transient unhandled-rejection warning. The
 * `.catch()` call creates and discards a *derived* promise — the
 * promise this function returns is untouched and still rejects
 * normally when the caller does `await` it, propagating the real
 * error through the normal try/catch in `runAction`.
 */
function armSettledWait(shipId: string): Promise<void> {
  const settled = waitForSettled(shipId);
  settled.catch(() => {});
  return settled;
}

/** Awaits the `ship_settled` receipt for `shipId` — the receipt discipline, not a timer. */
async function waitForSettled(shipId: string): Promise<void> {
  await waitFor((e) => {
    if (e.type !== "ship_settled") return false;
    const p = e.payload as ShipSettledEventPayload;
    return p.shipId === shipId;
  }, SHIP_SETTLED_TIMEOUT_MS);
}

/** Extracts the typed `ShipError` from a thrown `ShipCommandError`, falling back to a generic `"unknown"` for anything else (a task panic, a network hiccup). */
function toShipError(err: unknown): ShipError {
  if (err instanceof ShipCommandError) return err.shipError;
  return {
    kind: "unknown",
    message: err instanceof Error ? err.message : String(err),
    remedy: null,
  };
}
