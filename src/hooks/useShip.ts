/**
 * The ship flow for one worker's worktree: preflight → preview → commit /
 * push / compare page → receipt, plus the best-effort causal record and
 * optional AI prose that feed the compare page's body.
 *
 * The hook itself is a thin view over `shipReducer` (a pure state
 * machine) and holds no `try` blocks: every async step lives in a
 * module-level helper that reports back through `dispatch`, which keeps
 * the hook compilable by the React Compiler and every transition
 * unit-testable on its own. The rule tags below: B1 (a missing receipt
 * is an unconfirmed ship, not a failed one) is defined at
 * `SHIP_SETTLED_TIMEOUT_MS`; B2 (nothing-to-commit recovery) and B3
 * (mode-aware preflight) are the rules of the same name in
 * `docs/architecture.md`'s Ship Chain section.
 *
 * Over the daemon a ship mutation can outlive its rpc: the socket drops,
 * or the reply misses `rpcDeadlineMs`, while the commit or push keeps
 * running there; or the reply arrives but the receipt does not. Such an attempt is never "failed". It stays "running"
 * (no buttons, so no duplicate mutation) as "Awaiting Confirmation"
 * while the `ship_progress` rows and the `ship_settled` receipt, which
 * the daemon records and replays after a reconnect, say how it ended;
 * `reconcileUnconfirmed` has the rules.
 *
 * @module useShip
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { useAtomValue } from "jotai";
import { useEffect, useReducer, useRef } from "react";
import { toast } from "sonner";
import * as z from "zod";
import { onEvent } from "#lib/event-bus";
import { errorMessage } from "#lib/is-error";
import { CLAUDE_MODELS } from "#lib/models";
import { composeShipBody, generateCausalProse } from "#lib/ship-causal";
import { generateCommitMessage } from "#lib/ship-message";
import {
  gitPush,
  gitShipPreflight,
  gitStageCommit,
  isTauri,
  ShipCommandError,
  shipCompareUrl,
  shipContext,
} from "#lib/tauri";
import { isOutcomeUnknown, rpcDeadlineMs } from "#lib/transport";
import type { ShipContext, ShipError, ShipPreflight, StagingMode } from "#store/types";
import { selectedModelAtom } from "#store/ui";

/** Generation status for the optional AI prose section — see `regenerateProse`. */
export type AiProseState = "idle" | "generating" | "ready" | "failed";

/** Load status of the causal record — `"failed"` is shown as such, never as an endless load. */
export type ShipContextState = "loading" | "ready" | "failed";

/** Ship state machine states — see `shipReducer` for the transitions. */
type ShipState = "idle" | "preflighting" | "previewing" | "running" | "settled" | "failed";

/** One row of the live progress checklist, fed by `ship_progress` events. */
export interface ShipProgressRow {
  readonly step: string;
  readonly status: "running" | "ok" | "error";
  readonly detail: string | null;
}

/** Terminal outcome fields, populated as each step of the chosen action completes. */
interface ShipResult {
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
  /** Why the last generation failed (e.g. a missing API key), shown with the failure; `null` unless `aiProseState` is `"failed"`. */
  readonly aiProseError: string | null;
}

/** Every transition `shipReducer` knows. */
type ShipAction =
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
  | { readonly type: "proseFailed"; readonly reason: string }
  | { readonly type: "proseEdited"; readonly prose: string }
  | { readonly type: "actionStarted" }
  | { readonly type: "progressReported"; readonly row: ShipProgressRow }
  | { readonly type: "actionSettled"; readonly result: ShipResult }
  | { readonly type: "actionFailed"; readonly error: ShipError }
  /** The attempt's outcome could not be confirmed; the flow returns to idle, where `ShipPanel` reloads a current preview. */
  | { readonly type: "actionInterrupted" }
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
  aiProseError: null,
};

/**
 * The ship state machine: idle → preflighting → previewing → running →
 * settled | failed, with `reset` (and `actionInterrupted`, for a running
 * attempt that could not be confirmed) back to idle. Pure — every side effect lives in the module-level helpers that
 * dispatch into it.
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
      return { ...snapshot, aiProseState: "generating", aiProseError: null };
    case "proseReady":
      return { ...snapshot, aiProse: action.prose, aiProseState: "ready", aiProseError: null };
    case "proseFailed":
      // The previous prose (or `null`) stays: a failed regenerate never
      // wipes what the user already has.
      return { ...snapshot, aiProseState: "failed", aiProseError: action.reason };
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
    case "actionInterrupted":
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

/** One action's git steps for one `shipId`; resolves once the backend's `ship_settled` receipt has been recorded in `attempt`. */
type ShipSteps = (
  workerId: string,
  shipId: string,
  draft: ShipDraft,
  attempt: ShipAttempt,
) => Promise<ShipResult>;

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
 * Workers whose running attempt lost a reply and waits for the daemon's
 * record. A subset of `inFlightWorkers`, kept so a second ship request
 * can say why it did nothing. Added when `reconcileUnconfirmed` starts,
 * removed with the guard.
 */
const awaitingConfirmation = new Set<string>();

/** The newest refetch per worker, so a superseded refetch's failure can stay silent. */
const latestRefresh = new Map<string, symbol>();

/**
 * (B1) How long the receipt (`ship_settled`) may stay silent after the
 * final step's invoke resolves before the attempt counts as unconfirmed.
 * The clock starts when that invoke resolves, not when the call starts,
 * so a commit or push that the backend lets run for its full budget
 * (`git/cli.rs`: `MUTATE_TIMEOUT`, `PUSH_TIMEOUT`) is never mistaken for a
 * missing receipt; a backend give-up rejects the invoke itself. The event
 * and the invoke response travel separately, so 30s is the allowance for
 * the receipt to land after the response. Expiry is not a failure: the
 * flow shows "Awaiting Confirmation" and keeps waiting up to
 * `rpcDeadlineMs` of the final command (`reconcileUnconfirmed`). The
 * reconcile path also uses it as the grace for a receipt after a lost
 * call's terminal `ship_progress` row. Always passed explicitly rather
 * than relying on a default.
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
 * keeps the previous preview rather than clobbering the UI over a
 * transient refetch error, and says so in an error toast, because that
 * preview may describe the other staging mode. A `quiet` refetch (after
 * a failed action) leaves the action's error as the only message. A
 * failure of a refetch that a later one superseded stays silent.
 */
async function refreshPreflight(
  workerId: string,
  mode: StagingMode,
  dispatch: ShipDispatch,
  { quiet = false } = {},
): Promise<void> {
  const token = Symbol();
  latestRefresh.set(workerId, token);
  try {
    const preflight = await gitShipPreflight(workerId, mode);
    dispatch({ type: "preflightRefreshed", preflight, mode });
  } catch (err) {
    if (!quiet && latestRefresh.get(workerId) === token)
      toast.error(`Could Not Refresh The Preview: ${toShipError(err).message}`);
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
  } catch (err) {
    console.error("useShip: ship_context failed", err);
    if (!silent) dispatch({ type: "contextFailed" });
  }
}

/**
 * Generates the AI prose. Failure (no API key, network, refusal) sets
 * `aiProseState: "failed"` (with the reason in `aiProseError`, so a
 * missing API key reads differently from a network error) and leaves
 * `aiProse` as it was — the body
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
  } catch (err) {
    dispatch({ type: "proseFailed", reason: errorMessage(err) });
  }
}

/**
 * Runs one ship action: the in-flight guard, the per-attempt event
 * recorder and the terminal transition live here once. The guard is held
 * until the attempt has fully ended, including an unconfirmed one (see
 * `reconcileUnconfirmed`), so a second request for the same worker is
 * dropped meanwhile; it says so with an info toast only when the first
 * is awaiting confirmation, since a plain double-click needs no
 * explanation. After a failure the worktree may still have changed (a
 * commit landed, then the push was rejected), so preflight and the
 * causal record are refreshed silently before the guard is released:
 * a retry then starts from the real state (B2's recovery needs a
 * current `ahead`). An unconfirmed attempt instead returns the flow to
 * idle, which makes `ShipPanel` reload the preview loudly. The guard
 * is per module, not per mount, but the awaiting state itself lives in
 * the mounted flow: a panel remounted mid-attempt starts idle again and
 * its ship requests are dropped (with the info toast) until the
 * attempt ends.
 */
async function runAction(
  workerId: string,
  draft: ShipDraft,
  dispatch: ShipDispatch,
  steps: ShipSteps,
): Promise<void> {
  if (inFlightWorkers.has(workerId)) {
    if (awaitingConfirmation.has(workerId)) toast.info(STILL_AWAITING_NOTICE);
    return;
  }
  inFlightWorkers.add(workerId);

  const shipId = crypto.randomUUID();
  dispatch({ type: "actionStarted" });
  const attempt: ShipAttempt = { recorder: recordShip(workerId, shipId, dispatch), known: {} };

  let prUrl: string | undefined;
  try {
    const outcome = await carryOut(workerId, shipId, draft, dispatch, steps, attempt);
    if (outcome.kind === "settled") {
      dispatch({ type: "actionSettled", result: outcome.result });
      prUrl = outcome.result.prUrl;
    } else {
      if (outcome.kind === "failed") dispatch({ type: "actionFailed", error: outcome.error });
      if (outcome.kind === "interrupted") {
        // No quiet refetch: a failed one would leave the old preview
        // under a notice that says it was reloaded. Idle makes
        // `ShipPanel` run a loud preflight, which shows no ship button
        // until a current preview has loaded.
        dispatch({ type: "actionInterrupted" });
        toast.warning(outcome.notice);
      } else {
        await Promise.all([
          refreshPreflight(workerId, draft.mode, dispatch, { quiet: true }),
          fetchContext(workerId, dispatch, { silent: true }),
        ]);
      }
    }
  } finally {
    attempt.recorder.dispose();
    awaitingConfirmation.delete(workerId);
    inFlightWorkers.delete(workerId);
  }

  // The ship itself already succeeded; an opener failure (no default
  // browser, a URL outside the opener capability's scope) is a warning,
  // never a reason to flip the flow back to "failed". Only the desktop
  // shell has an opener bridge, so the flow auto-opens the compare page
  // only there; in the browser build nothing opens on its own, and the
  // receipt's Open Compare Page button opens a tab (`ShipPanel`'s
  // `openComparePage`, `window.open`).
  if (prUrl != null && isTauri()) {
    try {
      await openUrl(prUrl);
    } catch (err) {
      toast.warning(`Shipped, But Could Not Open The Compare Page: ${errorMessage(err)}`);
    }
  }
}

/** How one ship attempt ended. */
type ShipOutcome =
  | { readonly kind: "settled"; readonly result: ShipResult }
  | { readonly kind: "failed"; readonly error: ShipError }
  /** The outcome could not be confirmed; `notice` tells the user what to do next. */
  | { readonly kind: "interrupted"; readonly notice: string };

/**
 * Runs the steps and turns whatever they throw into an outcome. A
 * command's own error is a real failure. A lost reply (the rpc was sent,
 * its answer never came back) is not, and neither is an ok reply whose
 * receipt never shows: the daemon finishes a ship mutation even when the
 * connection that asked for it is gone, so the outcome is reconciled
 * from the daemon's own record instead.
 */
async function carryOut(
  workerId: string,
  shipId: string,
  draft: ShipDraft,
  dispatch: ShipDispatch,
  steps: ShipSteps,
  attempt: ShipAttempt,
): Promise<ShipOutcome> {
  try {
    return { kind: "settled", result: await steps(workerId, shipId, draft, attempt) };
  } catch (err) {
    if (err instanceof ReceiptMissing) {
      return reconcileUnconfirmed(workerId, err.cmd, dispatch, attempt, "replied");
    }
    if (!isOutcomeUnknown(err)) return { kind: "failed", error: toShipError(err) };
    return reconcileUnconfirmed(workerId, err.cmd, dispatch, attempt, "lost");
  }
}

/** The one row that stands for an unconfirmed step; `ShipProgress` shows an unknown step's raw name, so it is Title Case. */
const AWAITING_CONFIRMATION_STEP = "Awaiting Confirmation";

const STEP_FINISHED_NOTICE =
  "The Step Finished But Its Reply Was Lost. The Preview Is Reloading — Check It, Then Ship Again To Continue.";

const UNCONFIRMED_NOTICE =
  "No Confirmation Arrived. The Commit Or Push May Still Be Running, Or The Daemon May Have Restarted — The Preview Is Reloading; Check It Before Shipping Again.";

const STILL_AWAITING_NOTICE =
  "A Ship For This Worker Is Still Awaiting The Daemon's Confirmation. Try Again Once It Settles.";

/** The receipt of a ship whose reply was ok arrived late or not at all. */
const RECEIPT_MISSING_NOTICE =
  "The Step Finished But No Confirmation Arrived. The Preview Is Reloading — Check It Before Shipping Again.";

/**
 * Settles an attempt whose outcome the client cannot see: the last rpc
 * was sent but never answered (`"lost"`), or it answered ok and its
 * `ship_settled` receipt then stayed silent for `SHIP_SETTLED_TIMEOUT_MS`
 * (`"replied"`). Neither is a failure. The flow stays `"running"` (no
 * buttons, the in-flight guard held) as "Awaiting Confirmation" while the
 * daemon's record is awaited for up to `rpcDeadlineMs(cmd)`, the longest
 * the call could still have been running:
 *
 * - the `ship_settled` receipt decides it (success or failure);
 * - after a lost reply, the call's terminal `ship_progress` row without
 *   a receipt means the step finished but the chain stopped, so the
 *   receipt gets `SHIP_SETTLED_TIMEOUT_MS` more, then the flow returns to
 *   idle and the panel reloads the preview;
 * - nothing at all means the call may still be running or the daemon
 *   restarted: same return to idle, and the user decides from the
 *   reloaded preview.
 *
 * Both of the daemon's records are persistent events replayed to a
 * client that reconnects, which is how a reply lost with the socket is
 * recovered. A settled `"replied"` attempt reports the reply's own
 * values (`known`) and lets the receipt fill gaps; a `"lost"` one has
 * only the receipt to go on, with earlier steps' values filling gaps.
 */
async function reconcileUnconfirmed(
  workerId: string,
  cmd: string,
  dispatch: ShipDispatch,
  { recorder, known }: ShipAttempt,
  how: "lost" | "replied",
): Promise<ShipOutcome> {
  awaitingConfirmation.add(workerId);
  dispatch({
    type: "progressReported",
    row: {
      step: AWAITING_CONFIRMATION_STEP,
      status: "running",
      detail:
        how === "lost"
          ? "The Reply Was Lost — Waiting For The Daemon's Record."
          : "The Receipt Has Not Arrived — Waiting For The Daemon's Record.",
    },
  });

  const first = await recorder.next(rpcDeadlineMs(cmd), how === "lost" ? cmd : undefined);
  if (first === "terminal") await recorder.next(SHIP_SETTLED_TIMEOUT_MS);

  const receipt = recorder.receipt();
  if (receipt === null) {
    return {
      kind: "interrupted",
      notice:
        how === "replied"
          ? RECEIPT_MISSING_NOTICE
          : first === "terminal"
            ? STEP_FINISHED_NOTICE
            : UNCONFIRMED_NOTICE,
    };
  }
  if (receipt.status !== "ok") {
    const error = receipt.error ?? {
      kind: "unknown",
      message: "The Daemon Reported That The Ship Failed.",
      remedy: null,
    };
    dispatch({
      type: "progressReported",
      row: { step: AWAITING_CONFIRMATION_STEP, status: "error", detail: error.message },
    });
    return { kind: "failed", error };
  }
  dispatch({
    type: "progressReported",
    row: {
      step: AWAITING_CONFIRMATION_STEP,
      status: "ok",
      detail: "Confirmed By The Daemon's Record.",
    },
  });
  const fill = <T>(fromReceipt: T | null, fromFlow: T | undefined): T | undefined =>
    how === "replied" ? (fromFlow ?? fromReceipt ?? undefined) : (fromReceipt ?? fromFlow);
  return {
    kind: "settled",
    result: {
      commitSha: fill(receipt.commitSha, known.commitSha),
      pushedRef: fill(receipt.pushedRef, known.pushedRef),
      prUrl: fill(receipt.prUrl, known.prUrl),
    },
  };
}

/** "Commit Only": stage + commit as the final step, awaiting its own receipt. */
async function commitOnlySteps(
  workerId: string,
  shipId: string,
  { message, mode }: ShipDraft,
  { recorder, known }: ShipAttempt,
): Promise<ShipResult> {
  const commit = await gitStageCommit(workerId, shipId, message, mode, true);
  known.commitSha = commit.sha;
  await requireReceipt(recorder, "git_stage_commit");
  return { commitSha: commit.sha };
}

/** "Commit + Push": commit (or recover from B2's nothing-to-commit), then push as the final step. */
async function commitAndPushSteps(
  workerId: string,
  shipId: string,
  { message, mode, preflight }: ShipDraft,
  { recorder, known }: ShipAttempt,
): Promise<ShipResult> {
  const commitSha = await stageOrRecoverFromNothingToCommit(
    workerId,
    shipId,
    message,
    mode,
    preflight,
  );
  known.commitSha = commitSha ?? undefined;
  const push = await gitPush(workerId, shipId, true);
  known.commitSha = commitSha ?? push.sha;
  known.pushedRef = push.pushedRef;
  await requireReceipt(recorder, "git_push");
  return { commitSha: commitSha ?? push.sha, pushedRef: push.pushedRef };
}

/** "Commit + Push + Open Compare Page": as above, then the compare URL as the final step (`runAction` opens it in the desktop shell; the browser build's receipt button does). */
async function commitPushAndCompareSteps(
  workerId: string,
  shipId: string,
  { message, mode, preflight, composedBody }: ShipDraft,
  { recorder, known }: ShipAttempt,
): Promise<ShipResult> {
  const commitSha = await stageOrRecoverFromNothingToCommit(
    workerId,
    shipId,
    message,
    mode,
    preflight,
  );
  known.commitSha = commitSha ?? undefined;
  const push = await gitPush(workerId, shipId, false);
  known.commitSha = commitSha ?? push.sha;
  known.pushedRef = push.pushedRef;
  const [title = message, ...bodyLines] = message.split("\n");
  // The compare body is the composed causal body (deterministic Causal
  // Record + optional AI prose) when it has loaded, else the commit
  // message's own trailing lines — shipping never waits on the record.
  const body = composedBody ?? bodyLines.join("\n").trim();
  const prUrl = await shipCompareUrl(workerId, shipId, title, body);
  known.prUrl = prUrl;
  await requireReceipt(recorder, "ship_compare_url");
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

/** The `ship_settled` receipt, as the reconcile path reads it. */
interface ShipReceipt {
  readonly status: string;
  readonly commitSha: string | null;
  readonly pushedRef: string | null;
  readonly prUrl: string | null;
  readonly error: ShipError | null;
}

/** What ended a {@link ShipRecorder.next} wait. */
type RecorderWake = "receipt" | "terminal" | "timeout";

/**
 * The `ship_progress` steps each ship command ends on (`swarm_core`'s
 * ship chain): `git_stage_commit` ends on `commit` ok, or on a
 * `staging`/`commit` error; `git_push` on `push`; `ship_compare_url` on
 * `compare`. A row for one of these steps that is an error, or the
 * last step's `ok`, means the command finished.
 */
const COMMAND_STEPS = new Map<string, readonly string[]>([
  ["git_stage_commit", ["staging", "commit"]],
  ["git_push", ["push"]],
  ["ship_compare_url", ["compare"]],
]);

/** Everything the steps and the reconcile path share for one attempt. */
interface ShipAttempt {
  readonly recorder: ShipRecorder;
  /** What the flow has learned so far, to fill what a receipt leaves out. */
  readonly known: { commitSha?: string; pushedRef?: string; prUrl?: string };
}

/** The recorder of one ship attempt, from {@link recordShip}. */
interface ShipRecorder {
  /** The receipt, once it has arrived; `null` before. */
  readonly receipt: () => ShipReceipt | null;
  /**
   * Resolves `"receipt"` as soon as the receipt is recorded (now or
   * later), `"terminal"` as soon as `terminalOf`'s command has a
   * terminal row recorded, or `"timeout"` after `timeoutMs`.
   */
  readonly next: (timeoutMs: number, terminalOf?: string) => Promise<RecorderWake>;
  /** Drops the event subscriptions. */
  readonly dispose: () => void;
}

/**
 * Records this attempt's `ship_progress` rows and `ship_settled`
 * receipt from before the first invoke, because the backend can emit
 * either at any point during a call, including before its response, and
 * a call whose response is lost leaves them as the only evidence of how
 * it ended. Progress rows also feed the live checklist.
 */
function recordShip(workerId: string, shipId: string, dispatch: ShipDispatch): ShipRecorder {
  let receipt: ShipReceipt | null = null;
  const stepStatus = new Map<string, ShipProgressRow["status"]>();
  const waiters = new Set<() => void>();
  const notify = (): void => {
    for (const waiter of [...waiters]) waiter();
  };

  const offProgress = onEvent("ship_progress", (e) => {
    const parsed = ShipProgressPayloadSchema.safeParse(e.payload);
    if (!parsed.success) return;
    const { shipId: eventShipId, workerId: eventWorkerId, step, status, detail } = parsed.data;
    if (eventShipId !== shipId || eventWorkerId !== workerId) return;
    stepStatus.set(step, status);
    dispatch({ type: "progressReported", row: { step, status, detail: detail ?? null } });
    notify();
  });
  const offSettled = onEvent("ship_settled", (e) => {
    if (e.payload.shipId !== shipId || receipt !== null) return;
    const { status, commitSha, pushedRef, prUrl, error } = e.payload;
    receipt = {
      status,
      commitSha: commitSha ?? null,
      pushedRef: pushedRef ?? null,
      prUrl: prUrl ?? null,
      error: error ?? null,
    };
    notify();
  });

  const terminalRowSeen = (cmd: string): boolean => {
    const steps = COMMAND_STEPS.get(cmd) ?? [];
    return steps.some((step) => {
      const status = stepStatus.get(step);
      return status === "error" || (status === "ok" && step === steps.at(-1));
    });
  };
  const ready = (terminalOf: string | undefined): RecorderWake | null => {
    if (receipt !== null) return "receipt";
    return terminalOf !== undefined && terminalRowSeen(terminalOf) ? "terminal" : null;
  };

  return {
    receipt: () => receipt,
    next: (timeoutMs, terminalOf) => {
      const now = ready(terminalOf);
      if (now !== null) return Promise.resolve(now);
      const { promise, resolve } = Promise.withResolvers<RecorderWake>();
      const finish = (wake: RecorderWake): void => {
        clearTimeout(timer);
        waiters.delete(check);
        resolve(wake);
      };
      const check = (): void => {
        const wake = ready(terminalOf);
        if (wake !== null) finish(wake);
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      waiters.add(check);
      return promise;
    },
    dispose: () => {
      offProgress();
      offSettled();
    },
  };
}

/**
 * Thrown by {@link requireReceipt} when the final step's reply was ok but
 * its receipt stayed silent for `SHIP_SETTLED_TIMEOUT_MS`. Internal: `carryOut`
 * turns it into the same reconcile as a lost reply, so it never reaches
 * the user as an error.
 */
class ReceiptMissing extends Error {
  readonly cmd: string;

  constructor(cmd: string) {
    super("The Receipt Has Not Arrived.");
    this.name = "ReceiptMissing";
    this.cmd = cmd;
  }
}

/**
 * B1: after the final step's invoke resolved (command `cmd`), waits up to
 * `SHIP_SETTLED_TIMEOUT_MS` for the receipt. It is awaited here, not
 * from the call's start, so a slow but successful commit or push is
 * never mistaken for a missing receipt. A receipt that is still missing
 * throws {@link ReceiptMissing}: the git step may well have completed,
 * so the attempt is unconfirmed, not failed.
 */
async function requireReceipt(recorder: ShipRecorder, cmd: string): Promise<void> {
  if ((await recorder.next(SHIP_SETTLED_TIMEOUT_MS)) === "timeout") throw new ReceiptMissing(cmd);
}

/** Extracts the typed `ShipError` from a thrown `ShipCommandError`, falling back to a generic `"unknown"` for anything else (a task panic, a network hiccup). */
function toShipError(err: unknown): ShipError {
  if (err instanceof ShipCommandError) return err.shipError;
  return { kind: "unknown", message: errorMessage(err), remedy: null };
}
