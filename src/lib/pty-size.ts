import type { IDisposable, Terminal } from "@xterm/xterm";
import { invoke } from "#lib/tauri";

/**
 * Resizes a worker's terminal to `rows` × `cols` character cells (Rust's
 * `resize_worker` command). The shell sees the new size at once:
 * `SIGWINCH` on Unix, a pseudoconsole resize on Windows.
 */
export async function resizeWorker(id: string, rows: number, cols: number): Promise<void> {
  return invoke<void>("resize_worker", { id, rows, cols });
}

/**
 * Keeps `workerId`'s PTY the size of `terminal`: sends the current size
 * now, then every size xterm.js settles on (after each `FitAddon.fit()`).
 * Without it the PTY keeps its spawn size (80 × 24) and full-screen
 * programs lay out for a box that is not what the user sees.
 *
 * The first send is explicit because the initial fit can leave the
 * terminal at its default size, which fires no `onResize`. Failures are
 * ignored: a resize is advisory, and a killed worker has nothing left to
 * resize.
 *
 * Dispose the returned handle with the terminal.
 */
export function syncPtySize(
  terminal: Pick<Terminal, "rows" | "cols" | "onResize">,
  workerId: string,
): IDisposable {
  const send = (rows: number, cols: number) => {
    resizeWorker(workerId, rows, cols).catch(() => {});
  };
  send(terminal.rows, terminal.cols);
  return terminal.onResize(({ rows, cols }) => send(rows, cols));
}
