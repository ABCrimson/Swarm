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
    toast.error("Disk full", {
      description: `Cannot ${operation} \u2014 free up disk space and try again.`,
      duration: 10_000,
    });
    throw new Error(`Disk full: cannot ${operation}. Free up disk space and try again.`);
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
 * Writes to a `.tmp` file first, then renames it to the target path.
 * This prevents data corruption if the process is interrupted during write.
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

  // If the target already exists, remove it first
  const targetExists = await exists(path, { baseDir });
  if (targetExists) {
    await remove(path, { baseDir });
  }

  // Atomic rename: .tmp -> target
  await rename(tmpPath, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
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
