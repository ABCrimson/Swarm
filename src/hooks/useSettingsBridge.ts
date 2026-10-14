// ── useSettingsBridge ───────────────────────────────
// Pushes persisted app settings into the non-React (zustand) stores and
// the backend that consume them, and runs the once-on-launch update
// check. Called once at the app root. `appSettingsAtom` is preloaded
// before the first render (#store/persisted), so every value seen here
// is the user's real setting — never a pre-hydration default.
//
// The backend's agent concurrency cap and worker registry cap are the
// settings whose push can fail or hang, so their state is acknowledged:
// see `createAgentConcurrencySync`, `createMaxWorkersSync` and their
// sync atoms. Both syncs live here, at app lifetime: a page host that
// hides Settings must not be able to cancel a deadline or strand a queue.

import { type getDefaultStore, useAtomValue, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import * as z from "zod";
import { CAP_ACK_TIMEOUT_MS, createAcknowledgedSync } from "#lib/acknowledged-sync";
import {
  checkForUpdates,
  hasCapability,
  hasTransport,
  isTauri,
  readConfig,
  setAgentConcurrency,
  setMaxWorkers,
} from "#lib/tauri";
import { useAiStore } from "#store/ai";
import { useLogStore } from "#store/logs";
import { useMessageHistoryStore } from "#store/message-history";
import {
  AI_CONCURRENT_LIMIT_MAX,
  AI_CONCURRENT_LIMIT_MIN,
  agentConcurrencySyncAtom,
  appSettingsAtom,
  maxWorkersAtom,
  maxWorkersSyncAtom,
} from "#store/ui";

/** How long an agent concurrency push may stay unacknowledged; see `CAP_ACK_TIMEOUT_MS`. */
export const AGENT_CONCURRENCY_ACK_TIMEOUT_MS = CAP_ACK_TIMEOUT_MS;

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

/** Identifies the failure toast, so a later push or a late resolve can dismiss it. */
const MAX_WORKERS_TOAST_ID = "max-workers-sync";

type Store = ReturnType<typeof getDefaultStore>;

/**
 * Owns the acknowledged push of the agent concurrency cap through the
 * shared one-slot sync (`createAcknowledgedSync`, which documents the
 * ordering, rollback and timeout rules) and adds launch reconciliation.
 */
function createAgentConcurrencySync(store: Store) {
  const sync = createAcknowledgedSync({
    initial: store.get(appSettingsAtom).aiConcurrentLimit,
    call: setAgentConcurrency,
    show: (limit) =>
      store.set(appSettingsAtom, (prev) =>
        prev.aiConcurrentLimit === limit ? prev : { ...prev, aiConcurrentLimit: limit },
      ),
    getStatus: () => store.get(agentConcurrencySyncAtom),
    setStatus: (status) => store.set(agentConcurrencySyncAtom, status),
    logPrefix: "useSettingsBridge: setAgentConcurrency",
    failureTitle: "Agent Concurrency Not Applied",
    toastId: AGENT_CONCURRENCY_TOAST_ID,
  });
  let reconciling = false;

  return {
    apply: sync.apply,

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
      if (sync.touched) return;
      if (backend === store.get(appSettingsAtom).aiConcurrentLimit) {
        sync.acknowledge(backend);
      } else if (backend >= AI_CONCURRENT_LIMIT_MIN && backend <= AI_CONCURRENT_LIMIT_MAX) {
        sync.adopt(backend);
      } else {
        console.warn(
          `useSettingsBridge: backend agent_concurrency ${backend} is outside the Settings range ${AI_CONCURRENT_LIMIT_MIN}-${AI_CONCURRENT_LIMIT_MAX}; pushing the field's value`,
        );
        sync.push(store.get(appSettingsAtom).aiConcurrentLimit);
      }
    },

    cancelTimers: sync.cancelTimers,
  };
}

/**
 * Owns the acknowledged push of the worker registry cap, driven by
 * `maxWorkersAtom` the way the agent sync is driven by the settings
 * field: the Settings page writes the requested cap to the atom, and the
 * sync shows the server's replied value through the same atom. The
 * backend persists `max_workers` itself, so `reconcile` reads the saved
 * cap once instead of pushing the default.
 */
function createMaxWorkersSync(store: Store) {
  const sync = createAcknowledgedSync({
    initial: store.get(maxWorkersAtom),
    // Looked up at call time, not creation time.
    call: (cap) => setMaxWorkers(cap),
    show: (cap) => store.set(maxWorkersAtom, cap),
    getStatus: () => store.get(maxWorkersSyncAtom),
    setStatus: (status) => store.set(maxWorkersSyncAtom, status),
    logPrefix: "useSettingsBridge: setMaxWorkers",
    failureTitle: "Failed To Update Worker Registry Cap",
    toastId: MAX_WORKERS_TOAST_ID,
    onApplied: (applied) => toast.success(`Worker Registry Cap Set To ${applied}`),
  });
  let reconciling = false;

  return {
    apply: sync.apply,

    /** Once per launch, when a backend is reachable: shows the saved cap. */
    async reconcile(): Promise<void> {
      if (reconciling || !hasTransport()) return;
      reconciling = true;
      try {
        const saved = await readConfig("max_workers", z.int().min(1));
        // A cap committed while the read was in flight is newer than the saved one.
        if (saved !== null && !sync.touched) sync.adopt(saved);
      } catch (err) {
        // Unset resolves null; a rejection means the backend could not answer — keep the default.
        console.warn("useSettingsBridge: could not read max_workers", err);
      }
    },

    cancelTimers: sync.cancelTimers,
  };
}

export function useSettingsBridge(): void {
  const settings = useAtomValue(appSettingsAtom);
  const store = useStore();
  const updateCheckRan = useRef(false);
  const maxWorkers = useAtomValue(maxWorkersAtom);
  const [agentConcurrency] = useState(() => createAgentConcurrencySync(store));
  const [maxWorkersSync] = useState(() => createMaxWorkersSync(store));

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
    maxWorkersSync.apply(maxWorkers);
  }, [maxWorkers, maxWorkersSync]);

  useEffect(() => {
    void maxWorkersSync.reconcile();
    return maxWorkersSync.cancelTimers;
  }, [maxWorkersSync]);

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
