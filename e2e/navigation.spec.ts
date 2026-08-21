import { expect, test } from "@playwright/test";

// ── Navigation ────────────────────────────────────────
//
// Frontend-shell coverage only: this suite runs the real Vite build with
// NO Tauri backend (`isTauri()` is false, `invoke()` degrades gracefully —
// see `src/lib/tauri.ts`). It exercises routing, the sidebar, and
// backend-free empty states. It does NOT and cannot exercise worker
// spawn/PTY/real IPC — see `docs/e2e.md` for the documented boundary and
// the tauri-driver roadmap for closing it.

const SIDEBAR_PAGES = [
  { name: "Dashboard", heading: "Dashboard" },
  { name: "Workers", heading: "Workers" },
  { name: "Sessions", heading: "Sessions" },
  { name: "Metrics", heading: "Metrics" },
  { name: "Settings", heading: "Settings" },
] as const;

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
  test("loads the dashboard on first load", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText(/swarm/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });

  test("sidebar exposes an accessible nav landmark with every top-level page", async ({ page }) => {
    await page.goto("/");

    const nav = page.getByRole("navigation", { name: "Page Navigation" });
    await expect(nav).toBeVisible();

    for (const { name } of SIDEBAR_PAGES) {
      await expect(nav.getByRole("button", { name })).toBeVisible();
    }
  });

  test("clicking each sidebar item navigates to the corresponding page", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Page Navigation" });

    for (const { name, heading } of SIDEBAR_PAGES) {
      const navButton = nav.getByRole("button", { name });
      await navButton.click();

      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(navButton).toHaveAttribute("aria-current", "page");
    }
  });

  test("arrow keys move focus between sidebar nav items", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Page Navigation" });
    const buttons = nav.getByRole("button");

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
      page,
    }) => {
      await page.goto("/");

      const nav = page.getByRole("navigation", { name: "Page Navigation" });
      await expect(nav.getByRole("button", { name: heading })).toHaveCount(0);

      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog");
      await expect(palette).toBeVisible();
      await palette.getByRole("option", { name: command }).click();

      await expect(palette).toBeHidden();
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    });
  }

  test("Workers page shows the empty state (graph view) when no workers exist", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Page Navigation" })
      .getByRole("button", { name: "Workers" })
      .click();

    // Graph view is the default (see graphViewAtom's default in #store/ui).
    await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByText("No Workers Running. Spawn A Worker To See The Topology Graph."),
    ).toBeVisible();
  });

  test("Workers page shows the empty state (list view) when no workers exist", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Page Navigation" })
      .getByRole("button", { name: "Workers" })
      .click();
    await page.getByRole("tab", { name: "List" }).click();

    await expect(page.getByText("No Workers Running")).toBeVisible();
    await expect(page.getByText('Click "Spawn Worker" Or Press Ctrl+K')).toBeVisible();
  });

  test("Sessions page shows the empty state when no sessions exist", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Page Navigation" })
      .getByRole("button", { name: "Sessions" })
      .click();

    await expect(page.getByText("No Sessions Yet")).toBeVisible();
    await expect(page.getByText("Create A New Session To Get Started.")).toBeVisible();
  });
});
