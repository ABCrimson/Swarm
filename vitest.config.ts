import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

// `#components/*`, `#lib/*`, … resolve through package.json `imports`
// (see vite.config.ts) — no alias block here either.
//
// Deliberately no plugins: unit tests run on Vite's built-in Oxc JSX/TS
// transform WITHOUT the React Compiler, on both compiler pipelines, so
// they exercise plain component semantics. Compiler coverage is gated
// separately by `pnpm check:compiler` (scripts/check-react-compiler.ts).
export default defineConfig({
  // Mirrors vite.config.ts's `define` — components reading __APP_VERSION__
  // (e.g. Settings, Sidebar) need it defined to render under vitest/jsdom.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    globals: true,
    environment: "jsdom",
    // Measured 2026-09-23 (Vitest 5.0.1): isolate:false failed 3–18 tests (shared module state);
    // vmThreads ran 6.6–8.6s vs forks 6.0–6.4s. Set explicitly so Vitest stops hinting at them.
    pool: "forks",
    isolate: true,
    setupFiles: ["./src/test/setup.ts"],
    // Tests are colocated with their source. Keep this explicit: Vitest's
    // default glob would also collect the Playwright e2e/*.spec.ts suites.
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/workers/**", "src/vite-env.d.ts"],
      thresholds: {
        statements: 40,
        branches: 40,
        functions: 40,
        lines: 40,
      },
    },
  },
});
