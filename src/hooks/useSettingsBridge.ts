// ── useSettingsBridge ───────────────────────────────
// Pushes persisted app settings into the non-React (zustand) stores and
// the backend that consume them, and runs the once-on-launch update
// check. Called once at the app root. `appSettingsAtom` is preloaded
// before the first render (#store/persisted), so every value seen here
// is the user's real setting — never a pre-hydration default.

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useLogStore } from "#lib/log-store";
import { checkForUpdates, isTauri, setAgentConcurrency } from "#lib/tauri";
import { useAiStore } from "#store/ai";
import { useMessageHistoryStore } from "#store/message-history";
import { appSettingsAtom } from "#store/ui";

export function useSettingsBridge(): void {
  const settings = useAtomValue(appSettingsAtom);
  const updateCheckRan = useRef(false);
  // The backend persists its own copy of the agent concurrency cap
  // (config key `agent_concurrency`) and restores it at startup, so
  // only a CHANGE made during this launch is pushed. Comparing against
  // the last pushed value, rather than "has the effect run before",
  // keeps StrictMode's extra effect run from pushing anything.
  const pushedAgentConcurrency = useRef(settings.aiConcurrentLimit);

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
    if (settings.aiConcurrentLimit === pushedAgentConcurrency.current) return;
    pushedAgentConcurrency.current = settings.aiConcurrentLimit;

    // Logged, not toasted: a rejection (e.g. the Rust side's 1..=16
    // range check) must be visible somewhere, but this effect also
    // runs for changes the user did not directly make.
    setAgentConcurrency(settings.aiConcurrentLimit).catch((err: unknown) => {
      console.error("useSettingsBridge: setAgentConcurrency failed", err);
    });
  }, [settings.aiConcurrentLimit]);

  useEffect(() => {
    useMessageHistoryStore.getState().setMaxWorkers(settings.historyMaxWorkers);
  }, [settings.historyMaxWorkers]);

  // Once per app launch. Quiet on failure — a dev build has no update
  // endpoint, and an offline launch shouldn't toast an error.
  useEffect(() => {
    if (!settings.updateCheckOnLaunch || updateCheckRan.current || !isTauri()) return;
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
