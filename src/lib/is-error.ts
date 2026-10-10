/**
 * True for any `Error`. `Error.isError` (ES2026) also recognizes an Error
 * from another realm; `instanceof Error` covers what it misses: WebKit
 * before 318930@main (https://webkit.org/b/321064), which includes the
 * WebKit 18.4 floor (ADR-0037), returns false from `Error.isError` for a
 * `DOMException`, whose prototype chain still reaches `Error.prototype`.
 */
export const isError = (value: unknown): value is Error =>
  Error.isError(value) || value instanceof Error;

/** A readable message for any thrown or rejected value. */
export function errorMessage(value: unknown): string {
  return isError(value) ? value.message : String(value);
}
