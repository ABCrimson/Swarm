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

/**
 * Checks if an error indicates disk full / no space left on device.
 * Surfaces a user-friendly toast notification.
 */
function handleDiskError(err: unknown, operation: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (
    lower.includes("enospc") ||
    lower.includes("no space left") ||
    lower.includes("disk full") ||
    lower.includes("not enough space") ||
    lower.includes("there is not enough space on the disk")
  ) {
    toast.error("Disk Full", {
      description: `Cannot ${operation} \u2014 Free Up Disk Space And Try Again.`,
      duration: 10_000,
    });
    throw new Error(`Disk Full: Cannot ${operation}. Free Up Disk Space And Try Again.`);
  }

  throw err;
}

/**
 * Read a text file scoped to a base directory.
 *
 * @param path - Relative path within the base directory
 * @param baseDir - Tauri base directory scope (defaults to AppData)
 * @returns File contents as a string, or `null` if the file does not exist
 */
export async function readScopedTextFile(
  path: string,
  baseDir: BaseDirectory = BaseDirectory.AppData,
): Promise<string | null> {
  const fileExists = await exists(path, { baseDir });
  if (!fileExists) return null;
  return readTextFile(path, { baseDir });
}

/**
 * Write a text file using an atomic write pattern.
 *
 * Writes to a `.tmp` file first, then renames it onto the target path. On
 * POSIX, `rename()` is atomic and silently overwrites an existing target, so
 * the temp file replaces the target in a single filesystem operation with no
 * window where the target is missing. On Windows, `rename` fails if the
 * target already exists; in that case we fall back to remove-then-rename,
 * which reintroduces a brief window where the target doesn't exist (but only
 * on Windows, and only after the new data is already safely on disk in the
 * temp file).
 *
 * @param path - Relative path within the base directory
 * @param data - String content to write
 * @param baseDir - Tauri base directory scope (defaults to AppData)
 */
export async function writeScopedTextFile(
  path: string,
  data: string,
  baseDir: BaseDirectory = BaseDirectory.AppData,
): Promise<void> {
  const tmpPath = `${path}.tmp`;

  try {
    // Write to temporary file
    await writeTextFile(tmpPath, data, { baseDir });
  } catch (err) {
    handleDiskError(err, `write file "${path}"`);
  }

  try {
    // Atomic rename: .tmp -> target (overwrites on POSIX)
    await rename(tmpPath, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
  } catch {
    // Windows: rename fails when the target exists. Fall back to
    // remove-then-rename now that the new data is durably on disk.
    const targetExists = await exists(path, { baseDir });
    if (targetExists) {
      await remove(path, { baseDir });
    }
    await rename(tmpPath, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
  }
}

/**
 * Read a JSON file and parse its contents.
 *
 * @param path - Relative path within the base directory
 * @param baseDir - Tauri base directory scope (defaults to AppData)
 * @returns Parsed JSON value, or `null` if the file does not exist
 */
export async function readJsonFile<T>(
  path: string,
  baseDir: BaseDirectory = BaseDirectory.AppData,
): Promise<T | null> {
  const content = await readScopedTextFile(path, baseDir);
  if (content === null) return null;
  return JSON.parse(content) as T;
}

/**
 * Write a value as a JSON file using the atomic write pattern.
 *
 * @param path - Relative path within the base directory
 * @param data - Value to serialize as JSON
 * @param baseDir - Tauri base directory scope (defaults to AppData)
 */
export async function writeJsonFile<T>(
  path: string,
  data: T,
  baseDir: BaseDirectory = BaseDirectory.AppData,
): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeScopedTextFile(path, content, baseDir);
}
