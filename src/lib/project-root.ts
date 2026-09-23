// ── Persisted Project Root (worktree isolation) ──────────
//
// The one reader of the `default_repo_root` config key that the
// Project Root picker (`SpawnWorkerDialog`) writes. Both that picker (on
// load) and `spawnWorkerFromSpec` (`#lib/worker-spawn`) read it, so
// template, session and tool spawns get worktree isolation too, not
// only spawns started from the picker's own dialog.

import * as z from "zod";
import { readConfig } from "#lib/tauri";

/** Config key persisting the last-picked project root (`write_config`/`read_config`). */
export const DEFAULT_REPO_ROOT_KEY = "default_repo_root";

/**
 * The persisted default project root, or `null` when it is unset,
 * empty or not a string (`read_config` returns arbitrary JSON, so the
 * value is validated at the seam like every other command response in
 * `#lib/tauri`).
 *
 * Does not re-check that the path is still a git repository (an extra
 * round trip on every read). Callers that need that before acting on it
 * follow up with `validateRepoRoot` (`#lib/tauri`); `spawnWorkerFromSpec`
 * relies instead on the backend failing a spawn whose root is no longer
 * a repository.
 */
export async function getPersistedRepoRoot(): Promise<string | null> {
  return readConfig(DEFAULT_REPO_ROOT_KEY, z.string().min(1));
}
