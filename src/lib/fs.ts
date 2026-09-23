import {
  BaseDirectory,
  exists,
  readTextFile,
  remove,
  rename,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

export { BaseDirectory };

/** POSIX `/…`, Windows `C:\…` or `C:/…`, or UNC `\\server\…`. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** Rename attempts before an atomic write gives up (antivirus and indexers hold files briefly on Windows). */
const RENAME_ATTEMPTS = 3;
/** Delay before the second rename attempt; doubles for each later one. */
const RENAME_RETRY_MS = 50;

const DISK_FULL = /enospc|no space left|disk full|not enough space/i;

/**
 * Re-throws `err`. A disk-full error also raises a toast and becomes a
 * Title Case `Error` (with the original as `cause`).
 */
function rethrowDiskError(err: unknown, operation: string): never {
  const message = Error.isError(err) ? err.message : String(err);
  if (DISK_FULL.test(message)) {
    toast.error("Disk Full", {
      description: `Cannot ${operation}. Free Up Disk Space And Try Again.`,
      duration: 10_000,
    });
    throw new Error(`Disk Full: Cannot ${operation}. Free Up Disk Space And Try Again.`, {
      cause: err,
    });
  }
  throw err;
}

/**
 * Reads a text file, or resolves `null` when it does not exist.
 *
 * @param path - A path relative to `baseDir`, or an absolute path (for
 *   example one picked in an open dialog), for which `baseDir` is ignored.
 * @param baseDir - The base directory of a relative `path` (AppData by default).
 */
export async function readScopedTextFile(
  path: string,
  baseDir: BaseDirectory = BaseDirectory.AppData,
): Promise<string | null> {
  if (!(await exists(path, { baseDir }))) return null;
  return readTextFile(path, { baseDir });
}

/**
 * Writes a text file.
 *
 * An absolute path is a destination the user picked in a save dialog.
 * The dialog grants access to exactly that file, not to a temp file
 * next to it, so it is written in place.
 *
 * A path relative to `baseDir` is an app-owned file, written
 * atomically: the data goes to `<path>.tmp`, which is then renamed onto
 * `path` (the rename replaces an existing file on every platform). A
 * rename that fails, e.g. because antivirus holds the target for a
 * moment, is retried; if it keeps failing the temp file is removed, the
 * existing file is left untouched, and the error is thrown.
 *
 * @param path - A path relative to `baseDir`, or an absolute dialog-picked path.
 * @param data - The text to write.
 * @param baseDir - The base directory of a relative `path` (AppData by default).
 */
export async function writeScopedTextFile(
  path: string,
  data: string,
  baseDir: BaseDirectory = BaseDirectory.AppData,
): Promise<void> {
  const operation = `Write "${path}"`;

  if (ABSOLUTE_PATH.test(path)) {
    try {
      await writeTextFile(path, data);
    } catch (err) {
      rethrowDiskError(err, operation);
    }
    return;
  }

  const tmpPath = `${path}.tmp`;
  try {
    await writeTextFile(tmpPath, data, { baseDir });
  } catch (err) {
    rethrowDiskError(err, operation);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmpPath, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
      return;
    } catch (err) {
      if (attempt === RENAME_ATTEMPTS) {
        await remove(tmpPath, { baseDir }).catch(() => {});
        rethrowDiskError(err, operation);
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS * 2 ** (attempt - 1)));
    }
  }
}
