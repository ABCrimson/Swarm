import { defineConfig, devices } from "@playwright/test";

const ci = !!process.env.CI;

/**
 * CI tests what ships: the production bundle (Rolldown, the React
 * Compiler, minification) served by `vite preview`. Local runs reuse the
 * dev server on Tauri's devUrl port for fast iteration; `CI=1 pnpm
 * test:e2e` reproduces the CI setup (the preview build on 4173).
 */
const server = ci
  ? {
      command: "pnpm exec vite build && pnpm exec vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
    }
  : { command: "pnpm dev", url: "http://localhost:1420" };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: ci,
  // Retries only classify: a test that needs one is reported as flaky and,
  // with failOnFlakyTests, fails the run instead of passing silently. The
  // retry's trace is kept for diagnosis.
  retries: ci ? 2 : 0,
  failOnFlakyTests: ci,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "html",
  use: {
    baseURL: server.url,
    trace: {
      mode: "on-first-retry",
      snapshots: { dom: true, aria: true, screen: true },
    },
    // The shell runs motion animations; settle them instantly for deterministic assertions.
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Tauri renders in WKWebView (macOS) and WebKitGTK (Linux), both WebKit, so
    // WebKit is a real target. Opt-in: `pnpm exec playwright test --project=webkit`.
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      default: false,
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      default: false,
    },
  ],
  webServer: {
    ...server,
    reuseExistingServer: !ci,
    // CI includes the production build.
    timeout: ci ? 180_000 : 60_000,
  },
});
