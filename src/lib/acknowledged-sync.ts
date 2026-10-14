// ── Acknowledged one-slot sync ──────────────────────
// The push discipline shared by the backend caps the Settings page edits
// (agent concurrency, worker registry): see `createAcknowledgedSync`.

import { toast } from "sonner";
import { errorMessage } from "#lib/is-error";

/**
 * How long a push may stay unacknowledged before it counts as failed.
 * Tauri `invoke` has no timeout, so a wedged backend would otherwise
 * leave the field "applying" forever; the ws transport gives up on an RPC
 * on its own schedule. The call is a config write plus a live resize, so
 * a healthy backend answers in milliseconds: ten seconds tolerates a
 * loaded disk or a reconnecting socket without leaving the user staring
 * at a spinner. A resolve that arrives later is still adopted.
 * The deadline also frees the one in-flight slot (see
 * `createAcknowledgedSync`), so a call that never settles cannot hold
 * back the pushes queued behind it.
 */
export const CAP_ACK_TIMEOUT_MS = 10_000;

/**
 * Where the backend's copy of a cap stands relative to its Settings
 * field: `pending` while a push awaits the backend's acknowledgement,
 * `failed` once it is rejected or times out (the field has then been
 * rolled back to the last acknowledged value, and `requested` is what the
 * user asked for, kept for Retry). Not persisted: it only describes
 * pushes made during this launch.
 */
export type CapSync =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly requested: number }
  | {
      readonly status: "failed";
      readonly requested: number;
      readonly message: string;
      /** Pushes `requested` again, even when the field already shows it. */
      readonly retry: () => void;
    };

export interface AcknowledgedSyncOptions {
  /** What the backend holds as far as this launch knows (the field's first value). */
  readonly initial: number;
  /** The backend call; resolves to the cap in force, or `null` when no value came back. */
  readonly call: (requested: number) => Promise<number | null>;
  /** Makes `value` the field's value. */
  readonly show: (value: number) => void;
  readonly getStatus: () => CapSync;
  readonly setStatus: (status: CapSync) => void;
  /** Prefixes the console lines, e.g. `useSettingsBridge: setAgentConcurrency`. */
  readonly logPrefix: string;
  /** The failure toast's title; the toast carries a Retry action. */
  readonly failureTitle: string;
  /** Identifies the failure toast, so a later push or a late resolve can dismiss it. */
  readonly toastId: string;
  /** Runs when the newest push is acknowledged, with the cap in force. */
  readonly onApplied?: (applied: number) => void;
}

/**
 * Owns the acknowledged push of one backend cap. Kept outside React
 * state because its bookkeeping (what the backend last confirmed, which
 * push is newest) is read from timers and promise callbacks, not from
 * render.
 *
 * - The backend persists its own copy of the cap and restores it at
 *   startup, so `apply` pushes only a CHANGE made during this launch.
 *   Comparing against the last pushed value, rather than "has the effect
 *   run before", keeps StrictMode's extra effect run from pushing.
 *   `push` also shows the value and sends unconditionally, for a field
 *   that holds no value of its own (the Worker Registry Cap) or whose shown
 *   value may not be what the backend holds.
 * - A rejected or timed-out push rolls the field back to the last
 *   acknowledged value without pushing the rollback, and offers Retry.
 * - The backend's reply is authoritative: a push resolves to the cap in
 *   force, and a value that differs from the request is shown and becomes
 *   the acknowledged one. A reply without a value (`null`) acknowledges
 *   the requested value.
 * - At most one `call` is in flight. The server serializes calls only
 *   from the moment each reaches its lock, and each request runs as its
 *   own task, so two unawaited requests could reach it in either order;
 *   sending the next value only after the previous reply makes "last sent"
 *   mean "last applied". A value requested meanwhile waits in a one-slot
 *   queue (a newer request replaces it, so intermediate values are never
 *   sent) and goes out when the in-flight call settles or its ack timeout
 *   fires, whichever is first. Releasing on the timeout keeps a wedged
 *   invoke from stalling the queue, but the timed-out request may still be
 *   unsent (a reconnecting socket holds it) and can then reach the
 *   server's lock after the next one. So a call that settles late, after a
 *   newer push, with a value other than the latest one re-sends the latest
 *   value (through the same slot), and the server ends on it.
 * - Outcomes are sequenced: an older push's outcome never changes a newer
 *   push's pending or failed state, but an older push the backend
 *   acknowledged becomes the rollback target, and is shown at once if the
 *   newest push has already failed.
 */
export function createAcknowledgedSync(options: AcknowledgedSyncOptions) {
  const { call, show, getStatus, setStatus, logPrefix, failureTitle, toastId, onApplied } = options;
  /** The value the backend last confirmed (or reported at launch). */
  let acknowledged = options.initial;
  /** The value last pushed or adopted; the field equalling it is not a change. */
  let pushed = acknowledged;
  let newestPush = 0;
  /** The newest push the backend has acknowledged (0: none this launch). */
  let acknowledgedPush = 0;
  /** The call holding the single in-flight slot (null: free). */
  let inFlight: { released: boolean } | null = null;
  /** The newest request made while the slot was held; older ones are dropped. */
  let queued: { push: number; requested: number } | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  /** Makes `value` both the field value and the acknowledged one, without a push. */
  const adopt = (value: number): void => {
    acknowledged = value;
    pushed = value;
    show(value);
  };

  const fail = (requested: number, message: string): void => {
    pushed = acknowledged;
    show(acknowledged);
    const retry = (): void => {
      pushed = requested;
      start(requested);
      show(requested);
    };
    setStatus({ status: "failed", requested, message, retry });
    toast.error(failureTitle, {
      id: toastId,
      description: message,
      action: { label: "Retry", onClick: retry },
    });
  };

  /** Registers `requested` as the newest push: pending at once, sent when the slot is free. */
  const start = (requested: number): void => {
    const push = ++newestPush;
    if (getStatus().status === "failed") toast.dismiss(toastId);
    setStatus({ status: "pending", requested });
    if (inFlight) {
      queued = { push, requested };
      return;
    }
    send(push, requested);
  };

  /** Sends the queued request, if any, once the slot is free. */
  const sendQueued = (): void => {
    const next = queued;
    queued = null;
    if (next) send(next.push, next.requested);
  };

  const send = (push: number, requested: number): void => {
    const slot = { released: false };
    inFlight = slot;
    /** Frees the slot once per call, whichever of settle and timeout comes first. */
    const release = (): void => {
      if (slot.released) return;
      slot.released = true;
      inFlight = null;
      sendQueued();
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timers.delete(timer);
      timedOut = true;
      if (push === newestPush) {
        console.error(`${logPrefix} timed out`, requested);
        fail(requested, "The Backend Did Not Respond In Time");
      }
      release();
    }, CAP_ACK_TIMEOUT_MS);
    timers.add(timer);

    const settle = (): boolean => {
      clearTimeout(timer);
      timers.delete(timer);
      return push === newestPush;
    };

    // Logged as well as surfaced: a push can follow a change the user did
    // not directly make, and the console keeps the raw error.
    call(requested).then(
      (reply) => {
        const newest = settle();
        // `null`: the backend reported no value, so the request stands.
        const applied = reply ?? requested;
        // Any push the backend applied is the newest acknowledgement unless a
        // later push was already acknowledged, newest or not.
        if (push > acknowledgedPush) {
          acknowledgedPush = push;
          acknowledged = applied;
          // A newer push already failed and rolled the field back to an
          // older acknowledgement: show what the backend now holds instead.
          if (!newest && getStatus().status === "failed") {
            pushed = applied;
            show(applied);
          }
        }
        if (newest) {
          if (timedOut) {
            // The backend did apply it after all; undo the rollback.
            toast.dismiss(toastId);
            adopt(applied);
          } else if (applied !== requested) {
            // The cap in force differs from the request: show it.
            adopt(applied);
          }
          setStatus({ status: "idle" });
          onApplied?.(applied);
        }
        // A call released by its timeout may have been applied after a newer
        // one: put the user's latest value back on the server.
        if (
          timedOut &&
          push < newestPush &&
          applied !== pushed &&
          getStatus().status !== "failed"
        ) {
          start(pushed);
        }
        release();
      },
      (err: unknown) => {
        if (settle()) {
          console.error(`${logPrefix} failed`, err);
          if (!timedOut) fail(requested, errorMessage(err));
        }
        release();
      },
    );
  };

  return {
    /** Pushes `value` unless it is the value already pushed or adopted. */
    apply(value: number): void {
      if (value === pushed) return;
      pushed = value;
      start(value);
    },

    /**
     * Shows `value` and pushes it, even when it equals the value already
     * pushed or adopted; the field rolls back if the backend refuses it.
     */
    push(value: number): void {
      pushed = value;
      show(value);
      start(value);
    },

    /** Shows `value` and records it as what the backend holds, without a push. */
    adopt,

    /** Records `value` as what the backend holds, leaving the field as is. */
    acknowledge(value: number): void {
      acknowledged = value;
    },

    /** Whether a push was requested this launch (a read made before then may still land). */
    get touched(): boolean {
      return newestPush > 0;
    },

    cancelTimers(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
