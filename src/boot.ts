// The page's entry module (index.html). A static import evaluates before
// this module's body runs, so the app itself loads through `import()`
// once the polyfills are in place: no module that touches `Temporal`
// evaluates before it exists (`#lib/polyfills`). If either step fails, the
// catch shows the error and a reload button in #root, then rethrows so the
// engine still reports it.
import { errorMessage } from "#lib/is-error";
import { ensureTemporal } from "#lib/polyfills";

try {
  await ensureTemporal();
  await import("./main.tsx");
} catch (err) {
  showBootFailure(err);
  throw err;
}

/** Nothing has rendered and React's root error callbacks are not installed yet, so without this the window stays blank. */
function showBootFailure(err: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  const title = document.createElement("h1");
  title.textContent = "SWARM Could Not Start";
  const detail = document.createElement("p");
  detail.textContent = errorMessage(err);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => window.location.reload());
  root.replaceChildren(title, detail, reload);
}
