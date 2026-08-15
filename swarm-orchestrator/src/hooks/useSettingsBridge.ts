// ── useSettingsBridge ───────────────────────────────
// Pushes persisted app settings into the non-React (zustand) stores
// that consume them, and runs the once-on-launch update check. The
// jotai atoms only hydrate through React subscriptions, so this hook —
// called once at the app root — is the single place where settings
// values cross into module-level stores.

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

  useEffect(() => {
    useLogStore.getState().setMaxEntries(settings.logMaxEntries);
  }, [settings.logMaxEntries]);

  useEffect(() => {
    // Client-side limiter for the webview-direct chat streaming path
    // (`AIChat.tsx`) — bounds `useAiStream`'s `activeStreams` check only.
    useAiStore.getState().setConcurrentLimit(settings.aiConcurrentLimit);

    // Backend agent-turn scheduler cap for the provider-adapter path
    // (`agent_spawn`/`agent_send_turn`) — without this, the setting only
    // ever affected the webview path, and the Rust-side scheduler stayed
    // pinned at its Phase 3 startup default forever. Best-effort/quiet:
    // a missing Tauri bridge (web preview) or a transient IPC failure
    // here is not worth interrupting the user over — the client-side
    // limiter above still applies either way.
    setAgentConcurrency(settings.aiConcurrentLimit).catch(() => {});
  }, [settings.aiConcurrentLimit]);

  useEffect(() => {
    useMessageHistoryStore.getState().setMaxWorkers(settings.historyMaxWorkers);
  }, [settings.historyMaxWorkers]);

  // Once per app launch, after the persisted value has had a chance to
  // hydrate. Quiet on failure — a dev build has no update endpoint, and
  // an offline launch shouldn't toast an error.
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
