/**
 * The ship flow for one worker's worktree: preflight → preview → commit /
 * push / compare page → receipt, plus the best-effort causal record and
 * optional AI prose that feed the compare page's body.
 *
 * The hook itself is a thin view over `shipReducer` (a pure state
 * machine) and holds no `try` blocks: every async step lives in a
 * module-level helper that reports back through `dispatch`, which keeps
 * the hook compilable by the React Compiler and every transition
 * unit-testable on its own. The rule tags below: B1 (the receipt
 * timeout) is defined at `SHIP_SETTLED_TIMEOUT_MS`; B2 (nothing-to-commit
 * recovery) and B3 (mode-aware preflight) are the backend rules of the
 * same name in `docs/architecture.md`'s Ship Chain section.
 *
 * @module useShip
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { useAtomValue } from "jotai";
import { useEffect, useReducer, useRef } from "react";
import { toast } from "sonner";
import * as z from "zod";
import { onEvent, waitFor } from "#lib/event-bus";
import { errorMessage } from "#lib/is-error";
import { CLAUDE_MODELS } from "#lib/models";
import { composeShipBody, generateCausalProse } from "#lib/ship-causal";
import { generateCommitMessage } from "#lib/ship-message";
import {
  gitPush,
  gitShipPreflight,
  gitStageCommit,
  ShipCommandError,
  shipCompareUrl,
  shipContext,
} from "#lib/tauri";
import type { ShipContext, ShipError, ShipPreflight, StagingMode } from "#store/types";
import { selectedModelAtom } from "#store/ui";

/** Generation status for the optional AI prose section — see `regenerateProse`. */
export type AiProseState = "idle" | "generating" | "ready" | "failed";

/** Load status of the causal record — `"failed"` is shown as such, never as an endless load. */
export type ShipContextState = "loading" | "ready" | "failed";

/** Ship state machine states — see `shipReducer` for the transitions. */
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

/** Everything the ship flow shows; `shipReducer` is the only thing that changes it. */
export interface ShipSnapshot {
  readonly state: ShipState;
  readonly preflight: ShipPreflight | null;
  readonly message: string;
  readonly mode: StagingMode;
  readonly progress: readonly ShipProgressRow[];
  readonly error: ShipError | null;
  readonly result: ShipResult | null;
  /**
   * The causal record for this worker's current ship range —
   * `ship_context`'s response, fetched best-effort right after a
   * successful preflight. `null` until it loads; a failed fetch never
   * blocks shipping, it only sets `contextState: "failed"`.
   */
  readonly context: ShipContext | null;
  readonly contextState: ShipContextState;
  /** The editable AI prose (the "What Changed / Why" section) — `null` until a successful `regenerateProse`. User edits land here via `setAiProse`, independent of `aiProseState`. */
  readonly aiProse: string | null;
  readonly aiProseState: AiProseState;
}

/** Every transition `shipReducer` knows. */
export type ShipAction =
  | { readonly type: "preflightStarted" }
  | { readonly type: "preflightLoaded"; readonly preflight: ShipPreflight }
  | { readonly type: "preflightFailed"; readonly error: ShipError }
  | {
      readonly type: "preflightRefreshed";
      readonly preflight: ShipPreflight;
      /** The staging mode this preflight was fetched for. */
      readonly mode: StagingMode;
    }
  | { readonly type: "modeChanged"; readonly mode: StagingMode }
  | { readonly type: "messageChanged"; readonly message: string }
  | { readonly type: "contextRequested" }
  | { readonly type: "contextLoaded"; readonly context: ShipContext }
  | { readonly type: "contextFailed" }
  | { readonly type: "proseStarted" }
  | { readonly type: "proseReady"; readonly prose: string }
  | { readonly type: "proseFailed" }
  | { readonly type: "proseEdited"; readonly prose: string }
  | { readonly type: "actionStarted" }
  | { readonly type: "progressReported"; readonly row: ShipProgressRow }
  | { readonly type: "actionSettled"; readonly result: ShipResult }
  | { readonly type: "actionFailed"; readonly error: ShipError }
  | { readonly type: "reset" };

type ShipDispatch = (action: ShipAction) => void;

/** The state a worker's ship flow starts in (and returns to on `reset`, minus message/mode). */
export const INITIAL_SHIP_SNAPSHOT: ShipSnapshot = {
  state: "idle",
  preflight: null,
  message: "",
  mode: "all",
  progress: [],
  error: null,
  result: null,
  context: null,
  contextState: "loading",
  aiProse: null,
  aiProseState: "idle",
};

/**
 * The ship state machine: idle → preflighting → previewing → running →
 * settled | failed, with `reset` back to idle. Pure — every side effect
 * lives in the module-level helpers that dispatch into it.
 */
export function shipReducer(snapshot: ShipSnapshot, action: ShipAction): ShipSnapshot {
  switch (action.type) {
    case "preflightStarted":
      return { ...snapshot, state: "preflighting", error: null };
    case "preflightLoaded":
      return {
        ...snapshot,
        state: "previewing",
        preflight: action.preflight,
        // Seed the deterministic message once; never overwrite an edit.
        message:
          snapshot.message.trim() !== ""
            ? snapshot.message
            : generateCommitMessage(action.preflight),
      };
    case "preflightFailed":
      return { ...snapshot, state: "failed", error: action.error };
    case "preflightRefreshed":
      // A refetch for a mode the user has since toggled away from is
      // stale — out-of-order responses must never show the other mode's
      // files (B3).
      return action.mode === snapshot.mode
        ? { ...snapshot, preflight: action.preflight }
        : snapshot;
    case "modeChanged":
      return { ...snapshot, mode: action.mode };
    case "messageChanged":
      return { ...snapshot, message: action.message };
    case "contextRequested":
      return { ...snapshot, context: null, contextState: "loading" };
    case "contextLoaded":
      return { ...snapshot, context: action.context, contextState: "ready" };
    case "contextFailed":
      return { ...snapshot, context: null, contextState: "failed" };
    case "proseStarted":
      return { ...snapshot, aiProseState: "generating" };
    case "proseReady":
      return { ...snapshot, aiProse: action.prose, aiProseState: "ready" };
    case "proseFailed":
      // The previous prose (or `null`) stays: a failed regenerate never
      // wipes what the user already has.
      return { ...snapshot, aiProseState: "failed" };
    case "proseEdited":
      return { ...snapshot, aiProse: action.prose };
    case "actionStarted":
      return { ...snapshot, state: "running", progress: [], error: null, result: null };
    case "progressReported":
      return { ...snapshot, progress: [...snapshot.progress, action.row] };
    case "actionSettled":
      return { ...snapshot, state: "settled", result: action.result };
    case "actionFailed":
      return { ...snapshot, state: "failed", error: action.error };
    case "reset":
      return {
        ...INITIAL_SHIP_SNAPSHOT,
        message: snapshot.message,
        mode: snapshot.mode,
      };
  }
}

/** What `useShip` returns: the snapshot plus the actions that drive it. */
export interface UseShipReturn extends ShipSnapshot {
  readonly setMessage: (message: string) => void;
  /** Changes the staging mode and, when a preview is already showing, refetches preflight for the new mode (B3: the skipped/diffStat preview must be accurate per mode). */
  readonly setMode: (mode: StagingMode) => void;
  readonly setAiProse: (prose: string) => void;
  /** Runs preflight and (on success) seeds `message` with the deterministic template, moving to `"previewing"`, then loads the causal record. */
  readonly runPreflight: () => Promise<void>;
  /** Refetches the causal record after a failed load. */
  readonly retryContext: () => Promise<void>;
  /** Calls `generateCausalProse` against the current `context`/`preflight`, using the app's selected chat model. A no-op while either isn't loaded; the stream is aborted if the flow unmounts first. */
  readonly regenerateProse: () => Promise<void>;
  readonly commitOnly: () => Promise<void>;
  readonly commitAndPush: () => Promise<void>;
  readonly commitPushAndOpenCompare: () => Promise<void>;
  /** Returns to `"idle"` and clears all transient state — keeps `message`/`mode`. */
  readonly reset: () => void;
  /** `composeShipBody(context, preflight.diffStat, aiProse)` — `null` until both `context` and `preflight` are loaded. This is what `commitPushAndOpenCompare` sends as the compare URL's `body`. */
  readonly composedBody: string | null;
}

/**
 * The ship flow for `workerId`. One hook instance serves one worker for
 * its whole lifetime — `ShipPanel` keys its flow by worker id, so a
 * worker switch remounts it instead of reusing state (and late results)
 * from the previous worker.
 */
export function useShip(workerId: string): UseShipReturn {
  const [snapshot, dispatch] = useReducer(shipReducer, INITIAL_SHIP_SNAPSHOT);
  const selectedModel = useAtomValue(selectedModelAtom);
  const { state, preflight, message, mode, context, aiProse } = snapshot;

  // One abort signal per mounted flow: a worker switch remounts the flow,
  // and a prose stream still running for the old worker could only land
  // in a discarded reducer while it keeps spending tokens. Created in the
  // effect (not at render) so a Strict Mode re-mount gets a live signal.
  const flowSignal = useRef<AbortSignal | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    flowSignal.current = controller.signal;
    return () => controller.abort();
  }, []);

  const composedBody =
    context != null && preflight != null
      ? composeShipBody(context, preflight.diffStat, aiProse)
      : null;
  const draft: ShipDraft = { message, mode, preflight, composedBody };

  return {
    ...snapshot,
    composedBody,
    setMessage: (next) => dispatch({ type: "messageChanged", message: next }),
    setMode: (next) => {
      dispatch({ type: "modeChanged", mode: next });
      if (state === "previewing" || state === "failed") {
        void refreshPreflight(workerId, next, dispatch);
      }
    },
    setAiProse: (prose) => dispatch({ type: "proseEdited", prose }),
    runPreflight: () => loadPreflight(workerId, mode, dispatch),
    retryContext: () => fetchContext(workerId, dispatch),
    regenerateProse: () =>
      context != null && preflight != null
        ? generateProse(
            {
              context,
              diffStat: preflight.diffStat,
              branch: preflight.branch,
              baseBranch: preflight.baseBranch,
            },
            CLAUDE_MODELS[selectedModel].id,
            dispatch,
            flowSignal.current ?? undefined,
          )
        : Promise.resolve(),
    commitOnly: () => runAction(workerId, draft, dispatch, commitOnlySteps),
    commitAndPush: () => runAction(workerId, draft, dispatch, commitAndPushSteps),
    commitPushAndOpenCompare: () => runAction(workerId, draft, dispatch, commitPushAndCompareSteps),
    reset: () => dispatch({ type: "reset" }),
  };
}

// ── Async steps (module level: no `try` inside the hook) ─────────────

/** What an action commits and pushes: the preview as it stands when the button is pressed. */
interface ShipDraft {
  readonly message: string;
  readonly mode: StagingMode;
  readonly preflight: ShipPreflight | null;
  readonly composedBody: string | null;
}

/** One action's git steps for one `shipId`; resolves once the backend's `ship_settled` receipt arrives. */
type ShipSteps = (workerId: string, shipId: string, draft: ShipDraft) => Promise<ShipResult>;

/**
 * Module-level in-flight guard, keyed by `workerId` — checked
 * synchronously (no `await` between the check and the add) at the top
 * of every action, so a double-click on the same worker's Ship button
 * can never start two overlapping commits, regardless of React
 * re-render timing. Module-level rather than component state, so two
 * mounts of the same worker's panel would still share one guard.
 */
const inFlightWorkers = new Set<string>();

/**
 * DIRECTIVE (B1): how long the receipt wait (`ship_settled`) may stay
 * armed before the flow reports "failed". The wait is armed just before
 * the final step's invoke and so spans that whole call. It is a
 * frontend watchdog, not the backend's git budget: `git/cli.rs` bounds
 * the ship chain's `commit` (`MUTATE_TIMEOUT`) and `push`
 * (`PUSH_TIMEOUT`) at 600s each (`CREATE_TIMEOUT` is 120s, but that is
 * `git worktree add`, which the ship chain never runs). Known gap
 * (not yet fixed): 30s is shorter than those 600s budgets, so a commit
 * whose hooks, or a push, run past 30s is reported "failed" while the
 * backend still completes it. Always passed explicitly rather than
 * relying on `waitFor`'s 5s default.
 */
const SHIP_SETTLED_TIMEOUT_MS = 30_000;

/** `ship_progress` payload (Rust `ShipProgressPayload`), validated at the event-bus seam. */
const ShipProgressPayloadSchema = z.object({
  shipId: z.string(),
  workerId: z.string(),
  step: z.string(),
  status: z.enum(["running", "ok", "error"]),
  detail: z.string().nullish(),
});

/** The one `ship_settled` field the receipt wait matches on. */
const ShipSettledPayloadSchema = z.object({ shipId: z.string() });

async function loadPreflight(
  workerId: string,
  mode: StagingMode,
  dispatch: ShipDispatch,
): Promise<void> {
  dispatch({ type: "preflightStarted" });
  let preflight: ShipPreflight;
  try {
    preflight = await gitShipPreflight(workerId, mode);
  } catch (err) {
    dispatch({ type: "preflightFailed", error: toShipError(err) });
    return;
  }
  dispatch({ type: "preflightLoaded", preflight });
  await fetchContext(workerId, dispatch);
}

/**
 * Refetches preflight without leaving the current state — a failure
 * keeps the previous (still meaningful) preview rather than clobbering
 * the UI over a transient refetch error.
 */
async function refreshPreflight(
  workerId: string,
  mode: StagingMode,
  dispatch: ShipDispatch,
): Promise<void> {
  try {
    const preflight = await gitShipPreflight(workerId, mode);
    dispatch({ type: "preflightRefreshed", preflight, mode });
  } catch {
    // Keep the previous preview.
  }
}

/**
 * Best-effort causal record fetch. A failure never surfaces as a ship
 * error and never blocks the `"previewing"` transition — the Causal
 * Record is a preview enhancement, not a precondition for shipping. A
 * `silent` refetch (after a failed action) only ever replaces a record
 * with a newer one.
 */
async function fetchContext(
  workerId: string,
  dispatch: ShipDispatch,
  { silent = false } = {},
): Promise<void> {
  if (!silent) dispatch({ type: "contextRequested" });
  try {
    dispatch({ type: "contextLoaded", context: await shipContext(workerId) });
  } catch {
    if (!silent) dispatch({ type: "contextFailed" });
  }
}

/**
 * Generates the AI prose. Failure (no API key, network, refusal) sets
 * `aiProseState: "failed"` and leaves `aiProse` as it was — the body
 * then falls back to the deterministic Causal Record alone, never a
 * synthesized placeholder. `signal` aborts the stream when the flow
 * unmounts (see `useShip`).
 */
async function generateProse(
  input: Parameters<typeof generateCausalProse>[0],
  model: string,
  dispatch: ShipDispatch,
  signal: AbortSignal | undefined,
): Promise<void> {
  dispatch({ type: "proseStarted" });
  try {
    dispatch({ type: "proseReady", prose: await generateCausalProse(input, model, signal) });
  } catch {
    dispatch({ type: "proseFailed" });
  }
}

/**
 * Runs one ship action: the in-flight guard, `ship_progress` collection
 * and the terminal transition live here once. After a failure the
 * worktree may still have changed (a commit landed, then the push was
 * rejected), so preflight and the causal record are refreshed silently
 * before the guard is released — a retry then starts from the real
 * state (B2's recovery needs a current `ahead`).
 */
async function runAction(
  workerId: string,
  draft: ShipDraft,
  dispatch: ShipDispatch,
  steps: ShipSteps,
): Promise<void> {
  if (inFlightWorkers.has(workerId)) return;
  inFlightWorkers.add(workerId);

  const shipId = crypto.randomUUID();
  dispatch({ type: "actionStarted" });
  const offProgress = onEvent("ship_progress", (e) => {
    const parsed = ShipProgressPayloadSchema.safeParse(e.payload);
    if (!parsed.success) return;
    const { shipId: eventShipId, workerId: eventWorkerId, step, status, detail } = parsed.data;
    if (eventShipId !== shipId || eventWorkerId !== workerId) return;
    dispatch({ type: "progressReported", row: { step, status, detail: detail ?? null } });
  });

  let result: ShipResult;
  try {
    result = await steps(workerId, shipId, draft);
  } catch (err) {
    dispatch({ type: "actionFailed", error: toShipError(err) });
    await Promise.all([
      refreshPreflight(workerId, draft.mode, dispatch),
      fetchContext(workerId, dispatch, { silent: true }),
    ]);
    return;
  } finally {
    offProgress();
    inFlightWorkers.delete(workerId);
  }
  dispatch({ type: "actionSettled", result });

  // The ship itself already succeeded; an opener failure (no default
  // browser, a URL outside the opener capability's scope) is a warning,
  // never a reason to flip the flow back to "failed".
  if (result.prUrl != null) {
    try {
      await openUrl(result.prUrl);
    } catch (err) {
      toast.warning(`Shipped, But Could Not Open The Compare Page: ${errorMessage(err)}`);
    }
  }
}

/** "Commit Only": stage + commit as the final step, awaiting its own receipt. */
async function commitOnlySteps(
  workerId: string,
  shipId: string,
  { message, mode }: ShipDraft,
): Promise<ShipResult> {
  const settled = armSettledWait(shipId);
  const commit = await gitStageCommit(workerId, shipId, message, mode, true);
  await settled;
  return { commitSha: commit.sha };
}

/** "Commit + Push": commit (or recover from B2's nothing-to-commit), then push as the final step. */
async function commitAndPushSteps(
  workerId: string,
  shipId: string,
  { message, mode, preflight }: ShipDraft,
): Promise<ShipResult> {
  const commitSha = await stageOrRecoverFromNothingToCommit(
    workerId,
    shipId,
    message,
    mode,
    preflight,
  );
  // Armed *before* the call whose completion races the event: the
  // backend can emit ship_settled at any point during the push,
  // including before its invoke() promise resolves.
  const settled = armSettledWait(shipId);
  const push = await gitPush(workerId, shipId, true);
  await settled;
  return { commitSha: commitSha ?? push.sha, pushedRef: push.pushedRef };
}

/** "Commit + Push + Open Compare Page": as above, then the compare URL as the final step (`runAction` opens it). */
async function commitPushAndCompareSteps(
  workerId: string,
  shipId: string,
  { message, mode, preflight, composedBody }: ShipDraft,
): Promise<ShipResult> {
  const commitSha = await stageOrRecoverFromNothingToCommit(
    workerId,
    shipId,
    message,
    mode,
    preflight,
  );
  const push = await gitPush(workerId, shipId, false);
  const [title = message, ...bodyLines] = message.split("\n");
  // The compare body is the composed causal body (deterministic Causal
  // Record + optional AI prose) when it has loaded, else the commit
  // message's own trailing lines — shipping never waits on the record.
  const body = composedBody ?? bodyLines.join("\n").trim();
  const settled = armSettledWait(shipId);
  const prUrl = await shipCompareUrl(
    workerId,
    shipId,
    commitSha ?? push.sha,
    push.pushedRef,
    title,
    body,
  );
  await settled;
  return { commitSha: commitSha ?? push.sha, pushedRef: push.pushedRef, prUrl };
}

/**
 * DIRECTIVE (B2): a `gitStageCommit` call that fails with
 * `nothingToCommit` is not automatically a ship failure — a worker can
 * have already-committed, unpushed work (e.g. from an earlier "Commit
 * Only"), which `ShipPreflight.ahead > 0` reports. In that case, this
 * returns `null` (meaning "nothing new was staged, push whatever
 * HEAD already is") instead of re-throwing, so the push actions can
 * proceed straight to `gitPush` — which resolves its own sha
 * server-side (see `gitPush`'s doc). Any other error (including
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
    if (toShipError(err).kind === "nothingToCommit" && (preflight?.ahead ?? 0) > 0) {
      return null;
    }
    throw err;
  }
}

/**
 * Arms a `waitFor("ship_settled", shipId)` listener and returns it
 * immediately, with a no-op `.catch()` already attached so an early
 * rejection (the 30s timeout firing before the caller gets around to
 * `await`ing the returned promise) can never surface as a transient
 * unhandled-rejection warning. The `.catch()` creates and discards a
 * *derived* promise — the returned promise still rejects normally when
 * awaited, propagating the real error to `runAction`'s `catch`.
 */
function armSettledWait(shipId: string): Promise<unknown> {
  const settled = waitFor(
    (e) =>
      e.type === "ship_settled" &&
      ShipSettledPayloadSchema.safeParse(e.payload).data?.shipId === shipId,
    SHIP_SETTLED_TIMEOUT_MS,
  );
  settled.catch(() => {});
  return settled;
}

/** Extracts the typed `ShipError` from a thrown `ShipCommandError`, falling back to a generic `"unknown"` for anything else (a task panic, a network hiccup). */
function toShipError(err: unknown): ShipError {
  if (err instanceof ShipCommandError) return err.shipError;
  return { kind: "unknown", message: errorMessage(err), remedy: null };
}
