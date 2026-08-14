import { open } from "@tauri-apps/plugin-shell";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * Ship state machine: idle → preflighting → previewing → running →
 * settled | failed. One instance is scoped to one worker (`workerId`)
 * — see `components/ship/ShipPanel.tsx`, its sole consumer.
 */
export function useShip(workerId: string): UseShipReturn {
  const [state, setState] = useState<ShipState>("idle");
  const [preflight, setPreflight] = useState<ShipPreflight | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<StagingMode>("all");
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
      setMode("all");
      setProgress([]);
      setError(null);
      setResult(null);
    }
  }, [workerId]);

  const runPreflight = useCallback(async () => {
    setState("preflighting");
    setError(null);
    try {
      const result = await gitShipPreflight(workerId);
      setPreflight(result);
      setMessage((prev) => (prev.trim().length > 0 ? prev : generateCommitMessage(result)));
      setState("previewing");
    } catch (err) {
      setError(toShipError(err));
      setState("failed");
    }
  }, [workerId]);

  /** Shared body for every mutating action — the in-flight guard, event subscription, and terminal state handling live here once. */
  const runAction = useCallback(
    async (body: (shipId: string) => Promise<ShipResult>) => {
      if (inFlightWorkers.has(workerId)) return;
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
      } catch (err) {
        setError(toShipError(err));
        setState("failed");
      } finally {
        offProgress();
        inFlightWorkers.delete(workerId);
      }
    },
    [workerId],
  );

  const commitOnly = useCallback(async () => {
    await runAction(async (shipId) => {
      const commit = await gitStageCommit(workerId, shipId, message, mode, true);
      return { commitSha: commit.sha };
    });
  }, [runAction, workerId, message, mode]);

  const commitAndPush = useCallback(async () => {
    await runAction(async (shipId) => {
      const commit = await gitStageCommit(workerId, shipId, message, mode, false);
      // Registered *before* triggering the call whose own completion
      // races the event: the backend can emit ship_settled at any
      // point during the push, including before its invoke() promise
      // resolves, so the listener must already be armed when that
      // happens rather than being set up only after gitPush returns.
      const settled = waitForSettled(shipId);
      const push = await gitPush(workerId, shipId, commit.sha, commit.seqTo, true);
      await settled;
      return { commitSha: commit.sha, pushedRef: push.pushedRef };
    });
  }, [runAction, workerId, message, mode]);

  const commitPushAndOpenCompare = useCallback(async () => {
    await runAction(async (shipId) => {
      const commit = await gitStageCommit(workerId, shipId, message, mode, false);
      const push = await gitPush(workerId, shipId, commit.sha, commit.seqTo, false);
      const [title, ...bodyLines] = message.split("\n");
      // Same ordering rule as commitAndPush above — arm the listener
      // before the call that might trigger it.
      const settled = waitForSettled(shipId);
      const url = await shipCompareUrl(
        workerId,
        shipId,
        commit.sha,
        push.pushedRef,
        title ?? message,
        bodyLines.join("\n").trim(),
      );
      await settled;
      await open(url);
      return { commitSha: commit.sha, pushedRef: push.pushedRef, prUrl: url };
    });
  }, [runAction, workerId, message, mode]);

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

/** Awaits the `ship_settled` receipt for `shipId` — the receipt discipline, not a timer. */
async function waitForSettled(shipId: string): Promise<void> {
  await waitFor((e) => {
    if (e.type !== "ship_settled") return false;
    const p = e.payload as ShipSettledEventPayload;
    return p.shipId === shipId;
  });
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
