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
  // `createTauriStorage`'s `getItem` (#store/ui) always returns the
  // DEFAULT synchronously — the real persisted value only arrives later,
  // asynchronously, via `subscribe`. That means this effect's very
  // FIRST run on every launch sees the default, not (necessarily) the
  // user's real setting; a second run follows once hydration resolves
  // (or never, if the persisted value happens to equal the default, or
  // nothing was ever persisted). Guards the same way `updateCheckRan`
  // guards its own once-per-launch effect below.
  const aiConcurrentLimitRanOnce = useRef(false);

  useEffect(() => {
    useLogStore.getState().setMaxEntries(settings.logMaxEntries);
  }, [settings.logMaxEntries]);

  useEffect(() => {
    // Client-side limiter for the webview-direct chat streaming path
    // (`AIChat.tsx`) — bounds `useAiStream`'s `activeStreams` check only.
    // Harmless to apply on every run (including the pre-hydration
    // default): purely in-memory, never written to disk.
    useAiStore.getState().setConcurrentLimit(settings.aiConcurrentLimit);

    // Backend agent-turn scheduler cap for the provider-adapter path
    // (`agent_spawn`/`agent_send_turn`) — without this, the setting only
    // ever affected the webview path, and the Rust-side scheduler stayed
    // pinned at its Phase 3 startup default forever.
    //
    // Gated on this effect having already run once THIS launch (see
    // `aiConcurrentLimitRanOnce`'s doc above): calling this on the
    // pre-hydration default would write that default to
    // `agent_concurrency` on disk and resize the live scheduler for it,
    // silently clobbering a real custom value on disk if the app dies
    // (or hydration simply hasn't resolved yet) in that window — and
    // feeds a spurious down/up resize cycle into the scheduler on every
    // single launch (see `AgentScheduler::set_concurrency`'s BLOCK-1
    // doc for why a down/up cycle is exactly the shape that mattered).
    // Every invocation AFTER the first carries either the real hydrated
    // value or a legitimate live user edit — both of those must go
    // through.
    if (!aiConcurrentLimitRanOnce.current) {
      aiConcurrentLimitRanOnce.current = true;
      return;
    }

    // Not silently swallowed: a rejected call (e.g. the Rust side's
    // 1..=16 range validation) must be visible somewhere, or a
    // hand-edited/corrupt persisted value could diverge from the live
    // scheduler forever without any signal. Still not a toast — this
    // effect fires on every settings change, including ones the user
    // never directly initiated (e.g. a hydration replay), so a toast
    // here would be noisy in the common case.
    setAgentConcurrency(settings.aiConcurrentLimit).catch((err) => {
      console.error("useSettingsBridge: setAgentConcurrency failed", err);
    });
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
