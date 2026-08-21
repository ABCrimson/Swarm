import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/syne/index.css";
import "@fontsource-variable/dm-sans/index.css";
import "@fontsource-variable/dm-sans/wght-italic.css";
// modern-cmdk 1.2 base styles (dialog reveal animations via @property) —
// must load before our OKLCH theming overrides in global.css.
import "modern-cmdk/styles.css";
import "#styles/global.css";
import { enableMapSet } from "immer";

// Must run before any store module (all of which use immer's `produce` on
// Map-valued state, e.g. useWorkerStore's `workers: Map`) is evaluated —
// otherwise every Map-mutating store action throws in production.
enableMapSet();

import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

performance.mark("app-init-start");

/** Full-screen loading indicator shown while the main App chunk is fetched. */
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

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={<AppLoader />}>
      <App />
    </Suspense>
  </StrictMode>,
);

performance.mark("app-init-end");
performance.measure("app-init", "app-init-start", "app-init-end");
