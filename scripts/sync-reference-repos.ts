/**
 * Reference checkouts — `node scripts/sync-reference-repos.ts [name...]`.
 *
 * Syncs read-only, single-commit checkouts of the upstream sources Swarm is
 * pinned to into `.repos/` (gitignored), so code and agents are grounded in
 * the source of the installed version instead of memory:
 *
 *   .repos/tauri     tauri-apps/tauri at the tag of the workspace `tauri` pin
 *   .repos/xterm.js  xtermjs/xterm.js at the commit the pinned `@xterm/xterm`
 *                    beta was published from (betas are not tagged; the npm
 *                    registry records the commit as `gitHead`)
 *   .repos/react     facebook/react at the commit named by the `react` canary
 *                    pin (`19.3.0-canary-<sha8>-<date>`)
 *
 * Every version is read from package.json / Cargo.toml, so a pin bump needs
 * no edit here: rerun the script and the checkout moves. A checkout already at
 * the wanted commit is left alone. Never edit anything under `.repos/`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const reposDir = resolve(root, ".repos");

interface Source {
  /** Directory name under `.repos/`. */
  name: string;
  url: string;
  /** The ref to check out: a full commit SHA, or a tag name. */
  ref: () => Promise<string>;
}

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

/** The exact version of a dependency in package.json (they are all exact pins). */
const pinned = (name: string): string => {
  const version = pkg.dependencies[name];
  if (version == null) throw new Error(`package.json has no dependency "${name}"`);
  return version;
};

const sources: Source[] = [
  {
    name: "tauri",
    url: "https://github.com/tauri-apps/tauri.git",
    ref: async () => {
      const cargo = await readFile(resolve(root, "Cargo.toml"), "utf8");
      const version = /^tauri\s*=\s*\{\s*version\s*=\s*"=([^"]+)"/m.exec(cargo)?.[1];
      if (version == null) throw new Error("Cargo.toml: no exact `tauri` workspace pin");
      return `tauri-v${version}`;
    },
  },
  {
    name: "xterm.js",
    url: "https://github.com/xtermjs/xterm.js.git",
    ref: async () => {
      const version = pinned("@xterm/xterm");
      const response = await fetch(`https://registry.npmjs.org/@xterm/xterm/${version}`);
      if (!response.ok)
        throw new Error(`npm registry: @xterm/xterm@${version}: ${response.status}`);
      const { gitHead } = (await response.json()) as { gitHead?: string };
      if (gitHead == null) throw new Error(`npm registry: @xterm/xterm@${version} has no gitHead`);
      return gitHead;
    },
  },
  {
    name: "react",
    url: "https://github.com/facebook/react.git",
    ref: async () => {
      const version = pinned("react");
      // Canaries are named `<semver>-canary-<first 8 of the commit>-<date>`;
      // stable releases are tagged `v<semver>`.
      const short = /-canary-([0-9a-f]{8})-/.exec(version)?.[1];
      if (short == null) return `v${version}`;
      const response = await fetch(`https://api.github.com/repos/facebook/react/commits/${short}`, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
      });
      if (!response.ok) throw new Error(`GitHub API: react@${short}: ${response.status}`);
      return ((await response.json()) as { sha: string }).sha;
    },
  },
];

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run("git", args, { cwd })).stdout.trim();

/** The full commit SHA a tag or SHA names on the remote. */
const resolveCommit = async (url: string, ref: string): Promise<string> => {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const lines = await git(root, "ls-remote", url, `refs/tags/${ref}`, `refs/tags/${ref}^{}`);
  const rows = lines.split("\n").map((line) => line.split("\t"));
  // An annotated tag lists the tag object, then its peeled commit (`^{}`).
  const sha = (rows.find(([, name]) => name?.endsWith("^{}")) ?? rows[0])?.[0];
  if (sha == null || sha === "") throw new Error(`${url}: no tag ${ref}`);
  return sha;
};

const sync = async (source: Source): Promise<string> => {
  const dir = resolve(reposDir, source.name);
  const ref = await source.ref();
  const commit = await resolveCommit(source.url, ref);
  if (!existsSync(resolve(dir, ".git"))) {
    await mkdir(dir, { recursive: true });
    await git(dir, "init", "--quiet");
    await git(dir, "remote", "add", "origin", source.url);
  }
  const head = await git(dir, "rev-parse", "--verify", "--quiet", "HEAD").catch(() => "");
  if (head === commit) return `${source.name}: ${ref} (${commit.slice(0, 8)}) already synced`;
  // One commit, no history: a GitHub remote serves any full SHA.
  await git(dir, "fetch", "--quiet", "--depth", "1", "origin", commit);
  await git(dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", commit);
  return `${source.name}: ${ref} (${commit.slice(0, 8)}) synced`;
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !sources.some((source) => source.name === name));
if (unknown.length > 0) {
  console.error(
    `unknown reference repo: ${unknown.join(", ")} (have: ${sources.map((s) => s.name).join(", ")})`,
  );
  process.exit(1);
}

const selected = sources.filter((source) => wanted.length === 0 || wanted.includes(source.name));
await mkdir(reposDir, { recursive: true });
const results = await Promise.allSettled(selected.map(sync));
let failed = false;
for (const [i, result] of results.entries()) {
  if (result.status === "fulfilled") console.log(result.value);
  else {
    failed = true;
    console.error(`${selected[i]?.name}: FAILED — ${String(result.reason)}`);
  }
}
if (failed) process.exitCode = 1;
