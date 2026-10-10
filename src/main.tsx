import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/syne/index.css";
import "@fontsource-variable/dm-sans/index.css";
import "@fontsource-variable/dm-sans/wght-italic.css";
// modern-cmdk 1.2 base styles (dialog reveal animations via @property) —
// must load before our OKLCH theming overrides in global.css.
import "modern-cmdk/styles.css";
import "#styles/global.css";
import { type ReactNode, StrictMode, Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import { errorMessage } from "#lib/is-error";
import { isTauri } from "#lib/tauri";
import { type LogLevel, useLogStore } from "#store/logs";
import { preloadSettings } from "#store/persisted";
import { App } from "./App.tsx";

/**
 * Persisted settings, read once before anything renders (see
 * `#store/persisted`): every settings atom's first read then already
 * sees the user's value. `preloadSettings` never rejects. `null`
 * outside the desktop shell, where there is no settings file to wait
 * for, so the app renders without a loading pass.
 */
const settingsLoaded = isTauri() ? preloadSettings() : null;

/** Suspends until {@link settingsLoaded} settles. */
function SettingsGate({ children }: { readonly children: ReactNode }): ReactNode {
  if (settingsLoaded) use(settingsLoaded);
  return children;
}

/** Full-screen loading indicator shown while persisted settings load. */
function AppLoader(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100vw",
        height: "100vh",
        background: "oklch(0.06 0.02 220)",
        color: "oklch(0.78 0.18 205)",
        fontFamily: "'JetBrains Mono Variable', monospace",
        fontSize: "14px",
      }}
    >
      Initializing SWARM…
    </div>
  );
}

/**
 * Builds a root error callback that keeps React's console report and
 * also records the error on the in-app Logs page (source `react`), so
 * a render error an error boundary swallowed is still visible there.
 */
function reportRenderError(what: string, level: LogLevel) {
  return (error: unknown, info: { readonly componentStack?: string | undefined }): void => {
    console.error(`[react] ${what}:`, error);
    useLogStore.getState().addEntry({
      timestamp: Date.now(),
      level,
      source: "react",
      message: `${what}: ${errorMessage(error)}`,
      metadata: info.componentStack ? { componentStack: info.componentStack } : undefined,
    });
  };
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root, {
  onCaughtError: reportRenderError("Render Error Caught By An Error Boundary", "error"),
  onUncaughtError: reportRenderError("Uncaught Render Error", "error"),
  onRecoverableError: reportRenderError("Recovered Render Error", "warn"),
}).render(
  <StrictMode>
    <Suspense fallback={<AppLoader />}>
      <SettingsGate>
        <App />
      </SettingsGate>
    </Suspense>
  </StrictMode>,
);
