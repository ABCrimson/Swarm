/**
 * React Compiler coverage gate — `pnpm check:compiler`.
 *
 * Runs a production build with the real vite.config.ts (in memory; dist/
 * is untouched) and fails when:
 *
 * - a module in REQUIRED was emitted without the compiler's memo cache: a
 *   `c(N)` call into `react/compiler-runtime` (the per-render cache
 *   allocation) or the `react.memo_cache_sentinel` symbol it initialises
 *   slots with;
 * - a component, page or hook module in the bundle (`src/components/**`,
 *   `src/pages/**` `.tsx`, `src/hooks/**` `.ts(x)`) gets a React Compiler
 *   diagnostic (a skipped component or hook, a rule violation) and is not
 *   in SKIPPED, or a SKIPPED module no longer gets one.
 *
 * Why this exists: unit tests run without the compiler (vitest.config.ts
 * has no React plugin), and a compiler bail-out is silent — the component
 * ships uncompiled and every test stays green. The memo cache alone cannot
 * catch a skip, since a module with nothing to memoize legitimately has
 * none, so the diagnostics census recompiles each module's source with
 * `reportDiagnostics` (the build itself does not report them).
 * Modules are matched by their source path in each chunk's module map,
 * so chunk names and hashes are irrelevant.
 *
 * `NAPI_RS_FORCE_WASI=true pnpm check:compiler` checks the WASI binding
 * (the fallback where the native one cannot load) instead of the native
 * one; the report names the binding that ran. The loader falls back to
 * native without a word when WASI fails to load (e.g. a binding version
 * that no longer matches oxc-transform-react), so a forced run fails
 * unless the WASI binding is the one that ran.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { styleText } from "node:util";
import { __napiBindingTarget, transformSync } from "oxc-transform-react";
import type { Plugin, Rolldown } from "vite";
import { build } from "vite";

/** Modules that must always carry a memo cache — shared UI primitives rendered on every page, and the WebGPU hook behind the particle background. */
const REQUIRED = [
  "src/components/ui/Button.tsx",
  "src/components/ui/Pill.tsx",
  "src/components/ui/Spinner.tsx",
  "src/components/metrics/MetricCard.tsx",
  "src/components/layout/SplitPane.tsx",
  "src/hooks/useWebGPU.ts",
] as const;

/** Census modules the installed compiler skips on purpose, each with the reason. */
const SKIPPED: Readonly<Record<string, string>> = {
  "src/hooks/useWorkerEvents.ts":
    "a dynamic import() keeps the chat engine out of the startup chunk, and the installed compiler cannot lower import expressions (a BuildHIR Todo)",
};

/** Component and page modules (`.tsx`) and hook modules (`.ts`/`.tsx`) the census covers. */
const CENSUS = /^src\/(?:(?:components|pages)\/.+\.tsx|hooks\/.+\.tsx?)$/;

/** `(0, import_compiler_runtime.c)(12)` / `_c(12)` / `c(12)` — the useMemoCache allocation. */
const CACHE_CALL = /(?:\bc\)|\b_?c)\(\s*\d+\s*\)/;
const SENTINEL = "react.memo_cache_sentinel";

const root = resolve(import.meta.dirname, "..");
const normalize = (id: string): string =>
  relative(root, id.split("?")[0] ?? id).replaceAll("\\", "/");

let pipeline = "unknown";
const detectPipeline: Plugin = {
  name: "swarm:detect-react-compiler",
  configResolved(config) {
    const names = new Set(config.plugins.map((p) => p.name));
    if (names.has("vite:react-compiler")) pipeline = `oxc (${__napiBindingTarget})`;
  },
};

const result = await build({
  root,
  configFile: resolve(root, "vite.config.ts"),
  logLevel: "warn",
  plugins: [detectPipeline],
  build: { write: false, sourcemap: false, reportCompressedSize: false },
});
if (!("output" in result) && !Array.isArray(result)) {
  throw new Error("Expected a one-shot build result, got a watcher.");
}
const outputs: Rolldown.RolldownOutput[] = Array.isArray(result) ? result : [result];
const { NAPI_RS_FORCE_WASI } = process.env;
if (NAPI_RS_FORCE_WASI === "true" && __napiBindingTarget !== "wasm32-wasip1") {
  console.error("check:compiler: WASI forced but the native binding ran");
  process.exit(1);
}

/** Rendered code of every emitted source module, keyed by repo-relative path. */
const emitted = new Map<string, string>();
for (const output of outputs) {
  for (const item of output.output) {
    if (item.type !== "chunk") continue;
    for (const [id, module] of Object.entries(item.modules)) {
      const code = module.code ?? "";
      const key = normalize(id);
      emitted.set(key, (emitted.get(key) ?? "") + code);
    }
  }
}

const isCompiled = (code: string): boolean => CACHE_CALL.test(code) || code.includes(SENTINEL);

const failures: string[] = [];
for (const path of REQUIRED) {
  const code = emitted.get(path);
  if (code == null) {
    failures.push(`${path}: not in the bundle (moved or renamed? update REQUIRED)`);
  } else if (!isCompiled(code)) {
    failures.push(`${path}: emitted WITHOUT a memo cache (compiler bailed out)`);
  }
}

const census = [...emitted.keys()].filter((p) => CENSUS.test(p)).sort();

/** Recoverable and fatal compiler diagnostics for `path`, one line each. */
const diagnosticsOf = (path: string): string[] =>
  transformSync(path, readFileSync(resolve(root, path), "utf8"), {
    reactCompiler: { reportDiagnostics: true },
  }).errors.map((error) => `${error.severity}: ${error.message}`);

for (const path of census) {
  const diagnostics = diagnosticsOf(path);
  const skipped = Object.hasOwn(SKIPPED, path);
  if (diagnostics.length > 0 && !skipped) {
    failures.push(
      `${path}: the compiler reports ${diagnostics.join("; ")} (fix it, or list it in SKIPPED with the reason)`,
    );
  } else if (diagnostics.length === 0 && skipped) {
    failures.push(`${path}: compiles cleanly now (remove it from SKIPPED)`);
  }
}
for (const path of Object.keys(SKIPPED)) {
  if (!census.includes(path)) {
    failures.push(`${path}: in SKIPPED but not in the census (moved or renamed? update SKIPPED)`);
  }
}

const uncompiled = census.filter((p) => !isCompiled(emitted.get(p) ?? ""));
const allocations = [...emitted.values()].reduce(
  (sum, code) => sum + (code.match(new RegExp(CACHE_CALL, "g"))?.length ?? 0),
  0,
);
console.log(
  `React Compiler pipeline: ${pipeline}; ${census.length - uncompiled.length}/${census.length} component/page/hook modules carry a memo cache; ${allocations} cache allocations in total.`,
);
// Informational: a module can legitimately have no cache (nothing to memoize), so the
// memo cache gates only REQUIRED; a skip shows up as a diagnostic instead.
if (uncompiled.length > 0) console.log(`  without a memo cache: ${uncompiled.join(", ")}`);
for (const [path, reason] of Object.entries(SKIPPED)) console.log(`  skipped: ${path} — ${reason}`);

if (failures.length > 0) {
  console.error(styleText("red", `check:compiler FAILED (${failures.length}):`));
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    styleText(
      "green",
      `check:compiler OK — ${REQUIRED.length}/${REQUIRED.length} required modules compiled; ${census.length - Object.keys(SKIPPED).length}/${census.length} census modules free of compiler diagnostics (${Object.keys(SKIPPED).length} skipped by name).`,
    ),
  );
}
