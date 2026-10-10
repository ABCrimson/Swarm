import { readTextFile, stat } from "@tauri-apps/plugin-fs";
import { errorMessage } from "#lib/is-error";

/** Largest file the viewer will load, in bytes (2 MiB). */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** How much of the start of a file is scanned for NUL bytes. */
const BINARY_SNIFF_CHARS = 8192;

/** What the viewer can show for a file. */
export type FilePreview =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" }
  | { readonly kind: "too-large"; readonly bytes: number }
  | { readonly kind: "error"; readonly message: string };

/**
 * Reads a file for the read-only viewer, refusing what it cannot show.
 *
 * It first asks `stat()` for the size, so an oversized file is refused
 * before it is read (`src-tauri/capabilities/default.json` grants
 * `fs:allow-stat`, scoped like the reads). Should `stat()` fail anyway,
 * the whole file is read and its decoded length checked, so the viewer
 * still never renders an oversized file.
 *
 * A NUL byte near the start marks the file as binary. Never rejects:
 * failures resolve to `{ kind: "error" }`.
 */
export async function loadFilePreview(path: string): Promise<FilePreview> {
  try {
    const bytes = await stat(path).then(
      (info) => info.size,
      () => null,
    );
    if (bytes !== null && bytes > MAX_PREVIEW_BYTES) return { kind: "too-large", bytes };

    const text = await readTextFile(path);
    // UTF-8 never needs fewer bytes than UTF-16 code units, so this can
    // only under-count: anything it rejects really is over the limit.
    if (text.length > MAX_PREVIEW_BYTES) return { kind: "too-large", bytes: text.length };
    if (text.slice(0, BINARY_SNIFF_CHARS).includes("\0")) return { kind: "binary" };
    return { kind: "text", text };
  } catch (err) {
    return { kind: "error", message: errorMessage(err) };
  }
}

/**
 * Joins a directory path and an entry name with the separator the
 * directory path already uses, so a Windows root (`C:\code`) never ends
 * up with mixed separators. Synchronous, unlike `@tauri-apps/api/path`'s
 * `join()`, which is an IPC round trip per call.
 */
export function childPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** The last segment of a path, with either separator. */
export function basename(path: string): string {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? path;
}

/** Formats a byte count as a Title Case size label, e.g. "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Bytes`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
