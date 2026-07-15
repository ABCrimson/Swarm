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
import { checkForUpdates, isTauri } from "#lib/tauri";
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
    useAiStore.getState().setConcurrentLimit(settings.aiConcurrentLimit);
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
