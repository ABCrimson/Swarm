/**
 * React Compiler coverage gate — `pnpm check:compiler`.
 *
 * Runs a production build with the real vite.config.ts (in memory; dist/
 * is untouched) and fails unless every module in REQUIRED was emitted
 * with the compiler's memo cache: a `c(N)` call into
 * `react/compiler-runtime` (the per-render cache allocation) or the
 * `react.memo_cache_sentinel` symbol it initialises slots with.
 *
 * Why this exists: unit tests run without the compiler (vitest.config.ts
 * has no React plugin), and a compiler bail-out is silent — the component
 * ships uncompiled and every test stays green.
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
import { relative, resolve } from "node:path";
import { styleText } from "node:util";
import { __napiBindingTarget } from "oxc-transform-react";
import type { Plugin, Rolldown } from "vite";
import { build } from "vite";

/** Components that must always compile — shared UI primitives rendered on every page. */
const REQUIRED = [
  "src/components/ui/Button.tsx",
  "src/components/ui/Pill.tsx",
  "src/components/ui/Spinner.tsx",
  "src/components/metrics/MetricCard.tsx",
  "src/components/layout/SplitPane.tsx",
] as const;

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
if (process.env.NAPI_RS_FORCE_WASI === "true" && __napiBindingTarget !== "wasm32-wasip1") {
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

const components = [...emitted.keys()].filter((p) => /^src\/(components|pages)\/.+\.tsx$/.test(p));
const uncompiled = components.filter((p) => !isCompiled(emitted.get(p) ?? "")).sort();
const allocations = [...emitted.values()].reduce(
  (sum, code) => sum + (code.match(new RegExp(CACHE_CALL, "g"))?.length ?? 0),
  0,
);
console.log(
  `React Compiler pipeline: ${pipeline}; ${components.length - uncompiled.length}/${components.length} component/page modules carry a memo cache; ${allocations} cache allocations in total.`,
);
// Informational: a module can legitimately have no cache (nothing to memoize), so only REQUIRED gates.
if (uncompiled.length > 0) console.log(`  without a memo cache: ${uncompiled.join(", ")}`);

if (failures.length > 0) {
  console.error(styleText("red", `check:compiler FAILED (${failures.length}):`));
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    styleText(
      "green",
      `check:compiler OK — ${REQUIRED.length}/${REQUIRED.length} required components compiled.`,
    ),
  );
}
