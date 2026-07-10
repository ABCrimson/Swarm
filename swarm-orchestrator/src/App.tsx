import { useAtomValue } from "jotai";
import { lazy, Suspense, useEffect, useState } from "react";
import { CommandPalette } from "#components/command/CommandPalette";
import { AppShell } from "#components/layout/AppShell";
import { PerformanceOverlay } from "#components/metrics/PerformanceOverlay";
import { ErrorBoundary } from "#components/ui/ErrorBoundary";
import { SwarmToaster } from "#components/ui/Toast";
import { useAlerts } from "#hooks/useAlerts";
import { useAutoSnapshot } from "#hooks/useAutoSnapshot";
import { useMetrics } from "#hooks/useMetrics";
import { useSessionEvents } from "#hooks/useSessionEvents";
import { useTheme } from "#hooks/useTheme";
import { useWorkerEvents } from "#hooks/useWorkerEvents";
import { validateStoreData } from "#lib/store-integrity";
import { currentPageAtom } from "#store/ui";

// ── Lazy-loaded pages (code-split into separate chunks) ─────────
const Dashboard = lazy(() => import("#pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const Workers = lazy(() => import("#pages/Workers").then((m) => ({ default: m.Workers })));
const Sessions = lazy(() => import("#pages/Sessions").then((m) => ({ default: m.Sessions })));
const Metrics = lazy(() => import("#pages/Metrics").then((m) => ({ default: m.Metrics })));
const Settings = lazy(() => import("#pages/Settings").then((m) => ({ default: m.Settings })));
const Logs = lazy(() => import("#pages/Logs").then((m) => ({ default: m.Logs })));
const Tools = lazy(() => import("#pages/Tools").then((m) => ({ default: m.Tools })));
const Workspace = lazy(() => import("#pages/Workspace").then((m) => ({ default: m.Workspace })));

type PageId =
  | "dashboard"
  | "workers"
  | "sessions"
  | "metrics"
  | "settings"
  | "logs"
  | "tools"
  | "workspace";

const PAGE_MAP: Record<PageId, React.LazyExoticComponent<() => React.ReactElement>> = {
  dashboard: Dashboard,
  workers: Workers,
  sessions: Sessions,
  metrics: Metrics,
  settings: Settings,
  logs: Logs,
  tools: Tools,
  workspace: Workspace,
};

/** Minimal inline loading spinner — OKLCH colors only. */
function PageFallback(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          border: "2px solid oklch(0.3 0.02 220)",
          borderTop: "2px solid oklch(0.78 0.18 205)",
          borderRadius: "50%",
          animation: "spinner-rotate 0.8s linear infinite",
        }}
      />
    </div>
  );
}

/** Deferred auto-snapshot — activates after browser idle to avoid blocking startup. */
function DeferredAutoSnapshot(): null {
  useAutoSnapshot();
  return null;
}

/**
 * Root application component orchestrating global subscriptions,
 * page routing via Jotai atom, lazy-loaded pages, and deferred startup tasks.
 */
export function App(): React.ReactElement {
  const currentPage = useAtomValue(currentPageAtom);

  // Initialize global subscriptions (theme, events, metrics, alerts)
  useTheme();
  useWorkerEvents();
  useSessionEvents();
  useMetrics();
  useAlerts();

  // Defer auto-snapshot until after initial render is complete
  const [snapshotReady, setSnapshotReady] = useState(false);
  useEffect(() => {
    const id = requestIdleCallback(() => setSnapshotReady(true));
    return () => cancelIdleCallback(id);
  }, []);

  // Validate store integrity after startup (non-blocking)
  useEffect(() => {
    const id = requestIdleCallback(() => {
      validateStoreData().catch((err: unknown) => {
        console.warn("[App] Store integrity validation failed:", err);
      });
    });
    return () => cancelIdleCallback(id);
  }, []);

  const PageComponent = PAGE_MAP[currentPage];

  return (
    <ErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <AppShell pageKey={currentPage}>
          <ErrorBoundary>
            <Suspense fallback={<PageFallback />}>
              <PageComponent />
            </Suspense>
          </ErrorBoundary>
        </AppShell>
      </Suspense>
      <PerformanceOverlay />
      <CommandPalette />
      <SwarmToaster />
      {snapshotReady && <DeferredAutoSnapshot />}
    </ErrorBoundary>
  );
}
