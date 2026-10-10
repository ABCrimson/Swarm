// ── Runtime Polyfills ───────────────────────────────
// Engine gaps the app's code assumes are filled, closed by `src/boot.ts`
// before the first app module evaluates. Each one loads only where it is
// missing, so Chromium (WebView2, Chrome) never fetches a byte of it.

/**
 * Installs the `temporal-polyfill` implementation (ISO 8601 + Gregorian
 * calendars) as the global `Temporal` when the engine has none.
 * WKWebView (macOS), WebKitGTK (Linux) and Safari ship no Temporal; the
 * app calls it unguarded (timestamps, chart axes, the palette's
 * frecency, workflow names), so without this those paths throw. Like the
 * polyfill's `global` entry, it also installs the Temporal-aware
 * `Intl.DateTimeFormat` and `Date.prototype.toTemporalInstant`.
 */
export async function ensureTemporal(): Promise<void> {
  if ("Temporal" in globalThis) return;
  const { installImplementation } = await import("temporal-polyfill/shim");
  installImplementation();
}
