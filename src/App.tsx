import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CommandPalette } from "#components/command/CommandPalette";
import { AppShell } from "#components/layout/AppShell";
import { PageHost } from "#components/layout/PageHost";
import { PerformanceOverlay } from "#components/metrics/PerformanceOverlay";
import { ErrorBoundary } from "#components/ui/ErrorBoundary";
import { SwarmToaster } from "#components/ui/Toast";
import { useAgentSessionEvents } from "#hooks/useAgentSessionEvents";
import { useAlerts } from "#hooks/useAlerts";
import { useAutoSnapshot } from "#hooks/useAutoSnapshot";
import { useMetrics } from "#hooks/useMetrics";
import { useProvenanceEvents } from "#hooks/useProvenanceEvents";
import { useSessionEvents } from "#hooks/useSessionEvents";
import { useSettingsBridge } from "#hooks/useSettingsBridge";
import { useSystemLogEvents } from "#hooks/useSystemLogEvents";
import { useWorkerEvents } from "#hooks/useWorkerEvents";
import { connectEventBus } from "#lib/event-bus";
import { onIdle } from "#lib/idle";
import { errorMessage } from "#lib/is-error";
import { validateStoreData } from "#lib/store-integrity";

/** Runs the auto-snapshot loop; mounted only once startup has gone idle. */
function DeferredAutoSnapshot(): null {
  useAutoSnapshot();
  return null;
}

/**
 * Root component: connects the event bus, starts the app-wide
 * subscriptions (reduced motion, worker/session/provenance/log events,
 * metrics, alerts, settings), and renders the shell around the page host.
 *
 * Deferred until the first idle period: the auto-snapshot loop and the
 * persisted-store integrity check, so neither competes with startup.
 *
 * The toaster sits outside the root error boundary, so the toast a
 * root-level failure raises (and its "Retrying" follow-up) still shows
 * while the boundary's fallback replaces everything else.
 */
export function App(): React.ReactElement {
  // Connect the single ordered event bus once at mount.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void connectEventBus()
      .then((off) => {
        if (cancelled) off();
        else dispose = off;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[App] Event bus connection failed:", err);
        toast.error("Live Updates Unavailable", { description: errorMessage(err) });
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useWorkerEvents();
  useAgentSessionEvents();
  useProvenanceEvents();
  useSystemLogEvents();
  useSessionEvents();
  useMetrics();
  useAlerts();
  useSettingsBridge();

  const [startupIdle, setStartupIdle] = useState(false);
  useEffect(
    () =>
      onIdle(() => {
        setStartupIdle(true);
        validateStoreData().catch((err: unknown) => {
          console.warn("[App] Store integrity validation failed:", err);
        });
      }),
    [],
  );

  return (
    <>
      <ErrorBoundary>
        <AppShell>
          <PageHost />
        </AppShell>
        <PerformanceOverlay />
        <CommandPalette />
        {startupIdle && <DeferredAutoSnapshot />}
      </ErrorBoundary>
      <SwarmToaster />
    </>
  );
}
