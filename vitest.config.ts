import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

// `#components/*`, `#lib/*`, … resolve through package.json `imports`
// (see vite.config.ts) — no alias block here either.
//
// Deliberately no plugins: unit tests run on Vite's built-in Oxc JSX/TS
// transform WITHOUT the React Compiler, so they exercise plain component
// semantics. Compiler coverage is gated separately by
// `pnpm check:compiler` (scripts/check-react-compiler.ts).
//
// Two projects share this file. `unit` runs every `*.test.{ts,tsx}` on jsdom
// (`pnpm test`, `pnpm test:coverage`). `browser` runs the
// `*.browser.test.tsx` suites in real Chromium and WebKit through Playwright
// (`pnpm test:browser`), for what jsdom cannot model: the popover top layer,
// light dismiss, focus and layout. WebKit stands in for WKWebView and
// WebKitGTK. The browser server takes Vitest's own port range (23315 and up),
// never Vite's 1420 or the e2e preview port.
export default defineConfig({
  // Mirrors vite.config.ts's `define` — components reading __APP_VERSION__
  // (e.g. Settings, Sidebar) need it defined to render under vitest/jsdom.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    // `pnpm test:coverage` (CI runs it on every push and PR) measures the
    // unit project only. The thresholds are a ratchet, not a target: the
    // measured floor, rounded down (2026-11-04, Vitest 5.1.0: 92.47%
    // statements, 86.7% branches, 89.01% functions, 94.02% lines), so
    // coverage can only go up. Raise them whenever a change lifts the numbers.
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/workers/**", "src/vite-env.d.ts"],
      // Full table in the log, browsable report in coverage/index.html.
      reporter: ["text", "html"],
      thresholds: {
        statements: 92,
        branches: 86,
        functions: 89,
        lines: 94,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
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
          exclude: ["src/**/*.browser.test.tsx"],
          css: false,
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          // No setup file: the Tauri mocks and jsdom polyfills are for jsdom,
          // and a browser suite renders against the real platform.
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [
              { browser: "chromium", viewport: { width: 1280, height: 800 } },
              { browser: "webkit", viewport: { width: 1280, height: 800 } },
            ],
          },
        },
      },
    ],
  },
});
