import { expect, SIDEBAR_PAGES, test } from "./fixtures.ts";

// ── Navigation ────────────────────────────────────────
//
// Frontend-shell coverage only: this suite runs the Vite app (the dev
// server locally, the production preview build in CI; see
// playwright.config.ts) with NO Tauri backend (`isTauri()` is false,
// `invoke()` degrades gracefully — see `src/lib/tauri.ts`). It exercises
// routing, the sidebar, and backend-free empty states. It does NOT and
// cannot exercise worker spawn/PTY/real IPC — see `docs/e2e.md` for the
// documented boundary and the tauri-driver roadmap for closing it.

// Pages the command palette also navigates to (a sync, untransitioned
// page change, which must still render <main>).
const PALETTE_PAGES = [
  { command: "Go To Tools", heading: "Tools" },
  { command: "Go To Logs", heading: "Logs" },
  { command: "Go To Workspace", heading: "Workspace" },
] as const;

test.describe("Navigation", () => {
  test("loads the dashboard inside the app shell's landmarks", async ({ app, page }) => {
    await expect(page).toHaveTitle("SWARM Orchestrator");
    const banner = page.getByRole("banner");
    await expect(banner).toContainText("SWARM");
    // The app name is not a heading: every page renders its own <h1>.
    await expect(banner.getByRole("heading")).toHaveCount(0);
    await expect(app.nav).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(app.heading("Dashboard")).toBeVisible();
  });

  test("sidebar exposes an accessible nav landmark with every top-level page", async ({ app }) => {
    await expect(app.nav).toBeVisible();
    for (const name of SIDEBAR_PAGES) {
      await expect(app.nav.getByRole("button", { name })).toBeVisible();
    }
  });

  test("clicking each sidebar item navigates to the corresponding page", async ({ app }) => {
    for (const name of SIDEBAR_PAGES) {
      await app.goTo(name);
      await expect(app.nav.getByRole("button", { name })).toHaveAttribute("aria-current", "page");
    }
  });

  test("arrow keys move focus between sidebar nav items", async ({ app, page }) => {
    const buttons = app.nav.getByRole("button");

    await buttons.first().focus();
    await expect(buttons.first()).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(buttons.nth(1)).toBeFocused();

    await page.keyboard.press("End");
    await expect(buttons.last()).toBeFocused();

    await page.keyboard.press("Home");
    await expect(buttons.first()).toBeFocused();

    await page.keyboard.press("ArrowUp");
    await expect(buttons.last()).toBeFocused();
  });

  for (const { command, heading } of PALETTE_PAGES) {
    test(`the command palette navigates to "${heading}"`, async ({ app }) => {
      const palette = await app.openPalette();
      await palette.getByRole("option", { name: command }).click();

      await expect(palette).toBeHidden();
      await expect(app.heading(heading)).toBeVisible();
      await expect(app.nav.getByRole("button", { name: heading })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  }

  test("a visited page keeps its state when you navigate away and back", async ({ app, page }) => {
    // Settings keeps the threshold draft in component state: only a page
    // kept mounted while hidden still shows it.
    await app.goTo("Settings");
    await page.getByRole("button", { name: "Edit Thresholds" }).click();
    await page.getByLabel("CPU Warning").fill("55");

    await app.goTo("Metrics");
    await app.goTo("Settings");

    await expect(page.getByLabel("CPU Warning")).toHaveValue("55");
  });

  test("Tab reaches the sidebar from any page", async ({ app }) => {
    await app.goTo("Logs");

    const tabStops = app.nav.locator('button[tabindex="0"]');
    await expect(tabStops).toHaveCount(1);
    await expect(tabStops).toHaveAccessibleName("Logs");
  });

  test("Workers page shows the empty state (graph view) when no workers exist", async ({
    app,
    page,
  }) => {
    await app.goTo("Workers");

    // Graph view is the default (see graphViewAtom's default in #store/ui).
    await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByText("No Workers Running. Spawn A Worker To See The Topology Graph."),
    ).toBeVisible();
  });

  test("Workers page shows the empty state (list view) when no workers exist", async ({
    app,
    page,
  }) => {
    await app.goTo("Workers");
    await page.getByRole("tab", { name: "List" }).click();

    await expect(page.getByText("No Workers Running", { exact: true })).toBeVisible();
    await expect(page.getByText('Click "Spawn Worker" Or Press Ctrl+K')).toBeVisible();
  });

  test("Sessions page shows the empty state when no sessions exist", async ({ app, page }) => {
    await app.goTo("Sessions");

    await expect(page.getByText("No Sessions Yet")).toBeVisible();
    await expect(page.getByText("Create A New Session To Get Started.")).toBeVisible();
  });
});
