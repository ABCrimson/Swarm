// ── Persisted Project Root (worktree isolation) ──────────
//
// Single source of truth for reading the `default_repo_root` config
// key set by the Workers page's Project Root picker
// (`#pages/Workers`) and consumed by both that picker (on load) and
// `spawnWorkerFromSpec` (`#lib/worker-spawn`, adversarial review F6 —
// template/session spawns previously never populated `repoRoot` at
// all, silently skipping isolation).

import * as z from "zod";
import { readConfig } from "#lib/tauri";

/** Config key persisting the last-picked project root (write_config/read_config). */
export const DEFAULT_REPO_ROOT_KEY = "default_repo_root";

/**
 * `read_config` returns arbitrary JSON (`serde_json::Value` on the
 * Rust side) for any key — it is never typed. Validate at the seam
 * (matching this codebase's `safeParse`-at-the-seam discipline, see
 * `#lib/event-bus` and `spawnWorker`'s response validation in this
 * same file) rather than trusting a bare `as string` cast.
 */
const RepoRootConfigSchema = z.string().min(1).nullable();

/**
 * Reads the persisted default project root, Zod-validating the raw
 * `read_config` response. Returns `null` for a missing, empty, or
 * malformed value.
 *
 * Deliberately does **not** re-verify the path is still a real git
 * repository (that would mean an extra IPC round-trip on every read)
 * — callers that need that guarantee before acting on the UI (e.g.
 * the Workers page on mount) should follow up with
 * `validateRepoRoot` (`#lib/tauri`). `spawnWorkerFromSpec` skips that
 * extra check entirely and relies on Rust's `do_spawn_worker`
 * hard-fail guarantee to catch a since-invalidated root.
 */
export async function getPersistedRepoRoot(): Promise<string | null> {
  const raw = await readConfig<unknown>(DEFAULT_REPO_ROOT_KEY);
  const parsed = RepoRootConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
