/**
 * `Error.isError` (ES2026; unlike `instanceof`, also true for an Error
 * from another realm), falling back to `instanceof Error` in a webview
 * that predates it.
 */
export const isError: (value: unknown) => value is Error =
  typeof Error.isError === "function"
    ? Error.isError
    : (value: unknown): value is Error => value instanceof Error;

/** A readable message for any thrown or rejected value. */
export function errorMessage(value: unknown): string {
  return isError(value) ? value.message : String(value);
}
