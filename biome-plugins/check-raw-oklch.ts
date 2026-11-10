/**
 * Proof for the raw-OKLCH gate — `pnpm check:raw-oklch`.
 *
 * `biome ci .` passing only shows that no unlisted raw `oklch(` exists; a
 * plugin that silently stopped matching (a Grit node renamed in a Biome
 * bump, a regex typo) would pass too. This script fails unless:
 *
 * - the plugins, run on the fixtures in biome-plugins/fixtures/, report
 *   exactly the literals each fixture marks RAW (a fresh Biome config in a
 *   temp directory loads them, so the fixtures stay outside the repo's own
 *   lint scope);
 * - every known exception in the plugins still names a literal present in
 *   its file, so the list only shrinks as literals become tokens.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const plugins = ["no-raw-oklch.grit", "no-raw-oklch-css.grit"].map((name) =>
  join(import.meta.dirname, name),
);
/** Fixture file → the number of RAW literals it marks. */
const EXPECTED: Record<string, number> = { "raw-oklch.tsx": 4, "raw-oklch.css": 3 };

const failures: string[] = [];

const scratch = mkdtempSync(join(tmpdir(), "swarm-raw-oklch-"));
try {
  writeFileSync(
    join(scratch, "biome.json"),
    JSON.stringify({
      root: true,
      plugins: plugins.map((path) => path.replaceAll("\\", "/")),
      linter: { enabled: true, rules: { preset: "none" } },
      css: { parser: { tailwindDirectives: true } },
    }),
  );
  cpSync(join(import.meta.dirname, "fixtures"), scratch, { recursive: true });
  const biome = join(root, "node_modules", "@biomejs", "biome", "bin", "biome");
  const run = spawnSync(process.execPath, [biome, "lint", "--reporter=json", "."], {
    cwd: scratch,
    encoding: "utf8",
  });
  const report = JSON.parse(run.stdout) as {
    diagnostics: { category: string; location: { path: string } }[];
  };
  const found = new Map<string, number>();
  for (const { category, location } of report.diagnostics) {
    const file = location.path.replaceAll("\\", "/");
    if (category !== "plugin") failures.push(`${file}: unexpected ${category} diagnostic`);
    else found.set(file, (found.get(file) ?? 0) + 1);
  }
  for (const [file, count] of Object.entries(EXPECTED)) {
    const got = found.get(file) ?? 0;
    if (got !== count)
      failures.push(`${file}: expected ${count} raw literals, the gate found ${got}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// An exception, as Biome formats it:
//   and {
//     $filename <: r".*[/\x5C]<path, each / as [/\x5C]>",
//     $color <: r"(?s)<value>\).*"
//   }
const unescapeRegex = (pattern: string) => pattern.replaceAll(/\\(.)/g, "$1");
let exceptions = 0;
for (const plugin of plugins) {
  const source = readFileSync(plugin, "utf8");
  const entries = [
    ...source.matchAll(
      /\$filename <: r"\.\*\[\/\\x5C\](.+?)",\s*\$color <: r"\(\?s\)(.+?)\\\)\.\*"/g,
    ),
  ];
  // An exception this parser cannot read would escape the staleness check.
  const listed = source.split("\n").filter((line) => line.includes("$filename <:")).length;
  if (entries.length !== listed) {
    failures.push(`${plugin}: parsed ${entries.length} of ${listed} exceptions`);
  }
  exceptions += entries.length;
  for (const [, path, value] of entries) {
    // Both capture groups are mandatory in the pattern above.
    if (path === undefined || value === undefined)
      throw new Error(`${plugin}: exception match lost a group`);
    const file = unescapeRegex(path.replaceAll("[/\\x5C]", "/"));
    const literal = `oklch(${unescapeRegex(value)})`;
    if (!readFileSync(join(root, file), "utf8").includes(literal)) {
      failures.push(`${plugin}: ${file} no longer contains ${literal}; delete its exception`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `raw-OKLCH gate: the fixtures fail as marked; all ${exceptions} known exceptions are still present`,
);
