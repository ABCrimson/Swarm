import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

// `#components/*`, `#lib/*`, … resolve through package.json `imports`
// (see vite.config.ts) — no alias block here either.
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
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/__tests__/**", "src/workers/**", "src/vite-env.d.ts"],
      thresholds: {
        statements: 40,
        branches: 40,
        functions: 40,
        lines: 40,
      },
    },
  },
});
