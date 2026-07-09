import "#styles/global.css";
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
