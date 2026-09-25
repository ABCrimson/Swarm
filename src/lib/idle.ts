/**
 * Runs `callback` once the browser is idle and returns a function that
 * cancels it.
 *
 * Uses `requestIdleCallback` where the webview has it (WebView2 on
 * Windows). WebKit — WKWebView on macOS, WebKitGTK on Linux — has shipped
 * without it, and calling the missing global would throw inside a mount
 * effect, so there it falls back to a macrotask (`setTimeout(…, 0)`),
 * which still runs after the current render and paint work.
 */
export function onIdle(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const id = globalThis.requestIdleCallback(() => callback());
    return () => globalThis.cancelIdleCallback(id);
  }
  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
}
