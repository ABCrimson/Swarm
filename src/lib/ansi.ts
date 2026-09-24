// ── Terminal Escape Stripping ───────────────────────
// Plain-text views of PTY output (the worker detail preview) render the
// raw buffer; xterm.js interprets these sequences in the terminal view.

/**
 * VT/ANSI escape sequences: CSI (colours, cursor moves — ESC `[` or the
 * 8-bit CSI), OSC (titles, hyperlinks — ended by BEL or ST) and the
 * two-character ESC sequences (`ESC =`, `ESC 7`, `ESC M`, …).
 */
const ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is this pattern's purpose.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[0-?@-Z\\-_]/g;

/** Removes terminal escape sequences and normalises CRLF line endings. */
export function stripAnsi(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replaceAll("\r\n", "\n");
}
