// ── useSettingsBridge ───────────────────────────────
// Pushes persisted app settings into the non-React (zustand) stores and
// the backend that consume them, and runs the once-on-launch update
// check. Called once at the app root. `appSettingsAtom` is preloaded
// before the first render (#store/persisted), so every value seen here
// is the user's real setting — never a pre-hydration default.
//
// The backend's agent concurrency cap is the one setting whose push can
// fail or hang, so its state is acknowledged: see
// `createAgentConcurrencySync` and `agentConcurrencySyncAtom`.

import { type getDefaultStore, useAtomValue, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as z from "zod";
import { errorMessage } from "#lib/is-error";
import {
  checkForUpdates,
  hasCapability,
  hasTransport,
  isTauri,
  readConfig,
  setAgentConcurrency,
} from "#lib/tauri";
import { useAiStore } from "#store/ai";
import { useLogStore } from "#store/logs";
import { useMessageHistoryStore } from "#store/message-history";
import {
  AI_CONCURRENT_LIMIT_MAX,
  AI_CONCURRENT_LIMIT_MIN,
  agentConcurrencySyncAtom,
  appSettingsAtom,
} from "#store/ui";

/**
 * How long a push may stay unacknowledged before it counts as failed.
 * Tauri `invoke` has no timeout, so a wedged backend would otherwise
 * leave the field "applying" forever; the ws transport gives up on an RPC
 * on its own schedule. The call is a config write plus a semaphore
 * resize, so a healthy backend answers in milliseconds: ten seconds
 * tolerates a loaded disk or a reconnecting socket without leaving the
 * user staring at a spinner. A resolve that arrives later is still adopted.
 * The deadline also frees the one in-flight slot (see
 * `createAgentConcurrencySync`), so a call that never settles cannot
 * hold back the pushes queued behind it.
 */
export const AGENT_CONCURRENCY_ACK_TIMEOUT_MS = 10_000;

/**
 * What the backend runs with while the `agent_concurrency` config key is
 * unset: `AgentSchedulerConfig::default().concurrent_limit` in
 * `crates/swarm-core/src/agent/scheduler.rs`.
 */
const BACKEND_DEFAULT_AGENT_CONCURRENCY = 3;

/** The backend's accepted range (`set_agent_concurrency`), wider than the Settings field's. */
const BackendAgentConcurrency = z.int().min(1).max(16);

/** Identifies the failure toast, so a later push or a late resolve can dismiss it. */
const AGENT_CONCURRENCY_TOAST_ID = "agent-concurrency-sync";

type Store = ReturnType<typeof getDefaultStore>;

/**
 * Owns the acknowledged push of the agent concurrency cap. Kept outside
 * React state because its bookkeeping (what the backend last confirmed,
 * which push is newest) is read from timers and promise callbacks, not
 * from render.
 *
 * - The backend persists its own copy of the cap and restores it at
 *   startup, so only a CHANGE made during this launch is pushed (the one
 *   exception: a launch value the field cannot show, see `reconcile`).
 *   Comparing against the last pushed value, rather than "has the effect
 *   run before", keeps StrictMode's extra effect run from pushing.
 * - A rejected or timed-out push rolls the field back to the last
 *   acknowledged value without pushing the rollback, and offers Retry.
 * - The backend's reply is authoritative: a push resolves to the cap in
 *   force, and a value that differs from the request is shown and becomes
 *   the acknowledged one. A reply without a value (`null`) acknowledges
 *   the requested value.
 * - At most one `setAgentConcurrency` call is in flight. The server
 *   serializes calls only from the moment each reaches its lock, and
 *   each request runs as its own task, so two unawaited requests could
 *   reach it in either order; sending the next value only after the
 *   previous reply makes "last sent" mean "last applied". A value
 *   requested meanwhile waits in a one-slot queue (a newer request
 *   replaces it, so intermediate values are never sent) and goes out when
 *   the in-flight call settles or its ack timeout fires, whichever is
 *   first. Releasing on the timeout keeps a wedged invoke from stalling
 *   the queue, but the timed-out request may still be unsent (a
 *   reconnecting socket holds it) and can then reach the server's lock
 *   after the next one. So a call that settles late, after a newer push,
 *   with a value other than the latest one re-sends the latest value
 *   (through the same slot), and the server ends on it.
 * - Outcomes are sequenced: an older push's outcome never changes a newer
 *   push's pending or failed state, but an older push the backend
 *   acknowledged becomes the rollback target, and is shown at once if the
 *   newest push has already failed.
 */
function createAgentConcurrencySync(store: Store) {
  /** The value the backend last confirmed (or reported at launch). */
  let acknowledged = store.get(appSettingsAtom).aiConcurrentLimit;
  /** The value last pushed or adopted; the field equalling it is not a change. */
  let pushed = acknowledged;
  let newestPush = 0;
  /** The newest push the backend has acknowledged (0: none this launch). */
  let acknowledgedPush = 0;
  let reconciling = false;
  /** The call holding the single in-flight slot (null: free). */
  let inFlight: { released: boolean } | null = null;
  /** The newest request made while the slot was held; older ones are dropped. */
  let queued: { push: number; requested: number } | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const showLimit = (limit: number): void =>
    store.set(appSettingsAtom, (prev) =>
      prev.aiConcurrentLimit === limit ? prev : { ...prev, aiConcurrentLimit: limit },
    );

  /** Makes `limit` both the field value and the acknowledged one, without a push. */
  const adopt = (limit: number): void => {
    acknowledged = limit;
    pushed = limit;
    showLimit(limit);
  };

  const fail = (requested: number, message: string): void => {
    pushed = acknowledged;
    showLimit(acknowledged);
    const retry = (): void => {
      pushed = requested;
      start(requested);
      showLimit(requested);
    };
    store.set(agentConcurrencySyncAtom, { status: "failed", requested, message, retry });
    toast.error("Agent Concurrency Not Applied", {
      id: AGENT_CONCURRENCY_TOAST_ID,
      description: message,
      action: { label: "Retry", onClick: retry },
    });
  };

  /** Registers `requested` as the newest push: pending at once, sent when the slot is free. */
  const start = (requested: number): void => {
    const push = ++newestPush;
    if (store.get(agentConcurrencySyncAtom).status === "failed") {
      toast.dismiss(AGENT_CONCURRENCY_TOAST_ID);
    }
    store.set(agentConcurrencySyncAtom, { status: "pending", requested });
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
    const call = { released: false };
    inFlight = call;
    /** Frees the slot once per call, whichever of settle and timeout comes first. */
    const release = (): void => {
      if (call.released) return;
      call.released = true;
      inFlight = null;
      sendQueued();
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timers.delete(timer);
      timedOut = true;
      if (push === newestPush) {
        console.error("useSettingsBridge: setAgentConcurrency timed out", requested);
        fail(requested, "The Backend Did Not Respond In Time");
      }
      release();
    }, AGENT_CONCURRENCY_ACK_TIMEOUT_MS);
    timers.add(timer);

    const settle = (): boolean => {
      clearTimeout(timer);
      timers.delete(timer);
      return push === newestPush;
    };

    // Logged as well as surfaced: this effect also runs for changes the
    // user did not directly make, and the console keeps the raw error.
    setAgentConcurrency(requested).then(
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
          if (!newest && store.get(agentConcurrencySyncAtom).status === "failed") {
            pushed = applied;
            showLimit(applied);
          }
        }
        if (newest) {
          if (timedOut) {
            // The backend did apply it after all; undo the rollback.
            toast.dismiss(AGENT_CONCURRENCY_TOAST_ID);
            adopt(applied);
          } else if (applied !== requested) {
            // The cap in force differs from the request: show it.
            adopt(applied);
          }
          store.set(agentConcurrencySyncAtom, { status: "idle" });
        }
        // A call released by its timeout may have been applied after a newer
        // one: put the user's latest value back on the server.
        if (
          timedOut &&
          push < newestPush &&
          applied !== pushed &&
          store.get(agentConcurrencySyncAtom).status !== "failed"
        ) {
          start(pushed);
        }
        release();
      },
      (err: unknown) => {
        if (settle()) {
          console.error("useSettingsBridge: setAgentConcurrency failed", err);
          if (!timedOut) fail(requested, errorMessage(err));
        }
        release();
      },
    );
  };

  return {
    /** Pushes `limit` unless it is the value already pushed or adopted. */
    apply(limit: number): void {
      if (limit === pushed) return;
      pushed = limit;
      start(limit);
    },

    /**
     * Once per launch, when a backend is reachable: shows the cap the
     * backend actually runs with (the disk copy outlives the webview's
     * settings, and a swarmd page starts from defaults every load). A
     * backend value the field cannot show (11 to 16) is overwritten by
     * pushing the field's value, so the two never silently disagree.
     */
    async reconcile(): Promise<void> {
      if (reconciling || !hasTransport()) return;
      reconciling = true;
      let backend: number;
      try {
        backend =
          (await readConfig("agent_concurrency", BackendAgentConcurrency)) ??
          BACKEND_DEFAULT_AGENT_CONCURRENCY;
      } catch (err) {
        console.warn("useSettingsBridge: could not read agent_concurrency", err);
        return;
      }
      // The user already changed the cap while the read was in flight.
      if (newestPush > 0) return;
      if (backend === store.get(appSettingsAtom).aiConcurrentLimit) {
        acknowledged = backend;
      } else if (backend >= AI_CONCURRENT_LIMIT_MIN && backend <= AI_CONCURRENT_LIMIT_MAX) {
        adopt(backend);
      } else {
        console.warn(
          `useSettingsBridge: backend agent_concurrency ${backend} is outside the Settings range ${AI_CONCURRENT_LIMIT_MIN}-${AI_CONCURRENT_LIMIT_MAX}; pushing the field's value`,
        );
        pushed = store.get(appSettingsAtom).aiConcurrentLimit;
        start(pushed);
      }
    },

    cancelTimers(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export function useSettingsBridge(): void {
  const settings = useAtomValue(appSettingsAtom);
  const store = useStore();
  const updateCheckRan = useRef(false);
  const [agentConcurrency] = useState(() => createAgentConcurrencySync(store));

  useEffect(() => {
    useLogStore.getState().setMaxEntries(settings.logMaxEntries);
  }, [settings.logMaxEntries]);

  useEffect(() => {
    // Client-side limiter for the webview-direct chat streaming path
    // (`#lib/ai-chat`, through `#store/ai`'s `acquireStreamSlot`): purely
    // in-memory, so it is applied on every run.
    useAiStore.getState().setConcurrentLimit(settings.aiConcurrentLimit);

    // Backend agent-turn scheduler cap for the provider-adapter path
    // (`agent_spawn`/`agent_send_turn`). Each push resizes the live
    // scheduler and writes `agent_concurrency` to disk.
    agentConcurrency.apply(settings.aiConcurrentLimit);
  }, [settings.aiConcurrentLimit, agentConcurrency]);

  useEffect(() => {
    void agentConcurrency.reconcile();
    return agentConcurrency.cancelTimers;
  }, [agentConcurrency]);

  useEffect(() => {
    useMessageHistoryStore.getState().setMaxWorkers(settings.historyMaxWorkers);
  }, [settings.historyMaxWorkers]);

  // Once per app launch. Quiet on failure: the check fails whenever
  // the endpoint is unreachable or serves no valid manifest (offline,
  // or no release has published latest.json yet), and a check the
  // user did not ask for shouldn't toast an error. Skipped outright
  // where the build or shell cannot update (the swarmd browser page).
  useEffect(() => {
    if (
      !settings.updateCheckOnLaunch ||
      updateCheckRan.current ||
      !hasCapability("autoUpdate") ||
      !isTauri()
    ) {
      return;
    }
    updateCheckRan.current = true;

    checkForUpdates()
      .then((result) => {
        if (result.available) {
          toast.info(`Update Available: Version ${result.version ?? "Unknown"}`);
        }
      })
      .catch(() => {});
  }, [settings.updateCheckOnLaunch]);
}
