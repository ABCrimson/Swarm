/**
 * True for any `Error`. `Error.isError` (ES2026) also recognizes an Error
 * from another realm; `instanceof Error` covers what it misses: WebKit's
 * `Error.isError` (macOS WKWebView, Linux WebKitGTK) returns false for a
 * `DOMException` (https://webkit.org/b/292727), whose prototype chain
 * still reaches `Error.prototype`.
 */
export const isError = (value: unknown): value is Error =>
  Error.isError(value) || value instanceof Error;

/** A readable message for any thrown or rejected value. */
export function errorMessage(value: unknown): string {
  return isError(value) ? value.message : String(value);
}
