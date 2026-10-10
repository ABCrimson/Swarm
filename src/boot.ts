// The page's entry module (index.html). A static import evaluates before
// this module's body runs, so the app itself loads through `import()`
// once the polyfills are in place: no module that touches `Temporal`
// evaluates before it exists (`#lib/polyfills`).
import { ensureTemporal } from "#lib/polyfills";

await ensureTemporal();
await import("./main.tsx");
