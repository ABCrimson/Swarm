/**
 * Deterministic Conventional-Commit message generator — the ship flow's
 * zero-AI-dependency default. Type is inferred from the changed file
 * paths (all under `docs/` or Markdown → `docs`, all known config/
 * lockfile shapes → `chore`, anything else → `feat`), and the summary is
 * built from the file list + diff stat. The result seeds an editable
 * textarea; it is not meant to be the final word. No AI commit-message
 * generator exists: the only AI-written ship text is the optional PR-body
 * prose from `#lib/ship-causal`'s `generateCausalProse`.
 *
 * Unlike the rest of this app's UI copy, the generated message follows
 * the usual Conventional Commits style (lowercase `type:` prefix and
 * lowercase imperative summary, e.g. `feat: update 3 files`) rather than
 * Title Case — Title Case is a house rule for UI labels, not for git
 * commit content a reviewer will read in `git log`.
 *
 * @module ship-message
 */

import { pluralize } from "#lib/format";
import type { ShipPreflight } from "#store/types";

const MAX_LISTED_FILES = 20;

/** Path shapes that infer a `chore` commit when every changed file matches one. */
const CHORE_PATH_MARKERS = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "cargo.toml",
  "cargo.lock",
  ".gitignore",
  ".github/",
  "tsconfig",
  "biome.json",
  "vite.config",
  "vitest.config",
  "playwright.config",
];

function isDocsPath(path: string): boolean {
  return path.startsWith("docs/") || path.toLowerCase().endsWith(".md");
}

function isChorePath(path: string): boolean {
  const lower = path.toLowerCase();
  return CHORE_PATH_MARKERS.some((marker) => lower.includes(marker));
}

/** Infers a Conventional Commit type from the set of changed paths. `feat` is the fallback when the set is mixed or empty. */
export function inferCommitType(paths: readonly string[]): "docs" | "chore" | "feat" {
  if (paths.length === 0) return "feat";
  if (paths.every(isDocsPath)) return "docs";
  if (paths.every(isChorePath)) return "chore";
  return "feat";
}

/** The deduplicated set of paths a `mode: "all"` ship would actually stage, minus anything the deny list skipped. */
export function shippableCandidatePaths(preflight: ShipPreflight): string[] {
  const changed = new Set([...preflight.staged, ...preflight.unstaged, ...preflight.untracked]);
  const skipped = new Set(preflight.skipped.map((s) => s.path));
  return [...changed.difference(skipped)];
}

/**
 * Generates a deterministic Conventional-Commit message from a ship
 * preflight: `<type>: <summary>` followed by a diff-stat line and a
 * capped file list.
 */
export function generateCommitMessage(preflight: ShipPreflight): string {
  const paths = shippableCandidatePaths(preflight);
  const type = inferCommitType(paths);
  const { filesChanged, insertions, deletions } = preflight.diffStat;
  const files = pluralize("file", filesChanged);

  const summary = paths.length === 1 ? `update ${paths[0]}` : `update ${files}`;
  const lines = [`${type}: ${summary}`, "", `+${insertions}/-${deletions} across ${files}.`];

  if (paths.length > 0) {
    lines.push("", "Changed:", ...paths.slice(0, MAX_LISTED_FILES).map((path) => `- ${path}`));
    if (paths.length > MAX_LISTED_FILES) {
      lines.push(`- ...and ${paths.length - MAX_LISTED_FILES} more`);
    }
  }

  return lines.join("\n");
}
