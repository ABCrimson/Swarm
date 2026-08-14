import type { ShipPreflight } from "#store/types";

/**
 * Deterministic Conventional-Commit message generator — Phase 1's
 * zero-AI-dependency default. Type is inferred from the changed file
 * paths (`docs/` → `docs`, known config/lockfile shapes → `chore`,
 * anything else → `feat`), and the summary is built from the file
 * list + diff stat. The result is meant to seed an editable textarea,
 * not to be the final word — the AI-assisted generator
 * (`ship-copy.ts`) is Phase 2+ scope, out of bounds here (see the
 * ship-chain plan's ruling on the commit message).
 *
 * Unlike the rest of this app's UI copy, the generated message body
 * follows Conventional Commits' own convention (lowercase `type:`
 * prefix, sentence-case summary) rather than Title Case — Title Case
 * is a house rule for UI labels, not for git commit content a
 * reviewer will read in `git log`.
 */

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
  const skipped = new Set(preflight.skipped.map((s) => s.path));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [...preflight.staged, ...preflight.unstaged, ...preflight.untracked]) {
    if (skipped.has(path) || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
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
  const fileWord = (n: number): string => (n === 1 ? "file" : "files");

  const summary =
    paths.length === 1 ? `update ${paths[0]}` : `update ${filesChanged} ${fileWord(filesChanged)}`;

  const lines = [
    `${type}: ${summary}`,
    "",
    `+${insertions}/-${deletions} across ${filesChanged} ${fileWord(filesChanged)}.`,
  ];

  if (paths.length > 0) {
    lines.push("", "Changed:");
    for (const path of paths.slice(0, MAX_LISTED_FILES)) {
      lines.push(`- ${path}`);
    }
    if (paths.length > MAX_LISTED_FILES) {
      lines.push(`- ...and ${paths.length - MAX_LISTED_FILES} more`);
    }
  }

  return lines.join("\n");
}
