import { expect, type SidebarPage, test } from "./fixtures.ts";

// ── Navigation ────────────────────────────────────────
//
// Frontend-shell coverage only: this suite runs the real Vite build with
// NO Tauri backend (`isTauri()` is false, `invoke()` degrades gracefully —
// see `src/lib/tauri.ts`). It exercises routing, the sidebar, and
// backend-free empty states. It does NOT and cannot exercise worker
// spawn/PTY/real IPC — see `docs/e2e.md` for the documented boundary and
// the tauri-driver roadmap for closing it.

const SIDEBAR_PAGES = [
  "Dashboard",
  "Workers",
  "Sessions",
  "Metrics",
  "Settings",
] as const satisfies readonly SidebarPage[];

// Tools/Logs/Workspace have no sidebar entry — the command palette is
// their only navigation path (see CommandPalette.tsx's nav command
// comments). Covered here (not palette.spec.ts) because the assertion
// under test is "the page is reachable," not palette behavior itself.
const PALETTE_ONLY_PAGES = [
  { command: "Go To Tools", heading: "Tools" },
  { command: "Go To Logs", heading: "Logs" },
  { command: "Go To Workspace", heading: "Workspace" },
] as const;

test.describe("Navigation", () => {
  test("loads the dashboard inside the app shell's landmarks", async ({ app, page }) => {
    await expect(page).toHaveTitle("SWARM Orchestrator");
    await expect(page.getByRole("banner").getByRole("heading", { name: "SWARM" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Main Navigation" })).toBeVisible();
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

  for (const { command, heading } of PALETTE_ONLY_PAGES) {
    test(`"${heading}" has no sidebar entry and is reachable only via the command palette`, async ({
      app,
    }) => {
      await expect(app.nav.getByRole("button", { name: heading })).toHaveCount(0);

      const palette = await app.openPalette();
      await palette.getByRole("option", { name: command }).click();

      await expect(palette).toBeHidden();
      await expect(app.heading(heading)).toBeVisible();
    });
  }

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

    await expect(page.getByText("No Workers Running")).toBeVisible();
    await expect(page.getByText('Click "Spawn Worker" Or Press Ctrl+K')).toBeVisible();
  });

  test("Sessions page shows the empty state when no sessions exist", async ({ app, page }) => {
    await app.goTo("Sessions");

    await expect(page.getByText("No Sessions Yet")).toBeVisible();
    await expect(page.getByText("Create A New Session To Get Started.")).toBeVisible();
  });
});
