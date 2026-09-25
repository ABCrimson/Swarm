import { expect, test } from "./fixtures.ts";

// ── Command Palette ──────────────────────────────────
//
// Frontend-shell coverage only — see docs/e2e.md for the no-backend
// boundary. Navigation commands work headless because they only touch
// client-side Jotai state (`currentPageAtom`); commands that call the
// backend (spawning a worker, taking a snapshot) cannot be observed past
// the palette without a Tauri bridge, so these specs stick to navigation.

test.describe("Command Palette", () => {
  test("opens with Ctrl+K, labeled as the SWARM Command Palette", async ({ app }) => {
    const palette = await app.openPalette();
    await expect(palette.getByPlaceholder("Type A Command Or Search...")).toBeFocused();
  });

  test("Escape closes the palette", async ({ app, page }) => {
    const palette = await app.openPalette();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("typing a specific query filters the list down to matching commands", async ({ app }) => {
    const palette = await app.openPalette();

    await palette.getByPlaceholder("Type A Command Or Search...").fill("spawn worker");

    await expect(palette.getByRole("option", { name: "Spawn Worker" })).toBeVisible();
    // Unrelated commands whose label/keywords share no fuzzy-orderable
    // characters with "spawn worker" are excluded outright by the
    // scorer (see modern-cmdk's default-scorer: a null score removes
    // the item from `filteredIds` entirely) — not just re-ordered.
    await expect(palette.getByRole("option", { name: "Go To Metrics" })).toHaveCount(0);
    await expect(palette.getByRole("option", { name: "Toggle Sidebar" })).toHaveCount(0);
  });

  test("a query matching nothing shows the empty state", async ({ app }) => {
    const palette = await app.openPalette();

    await palette.getByPlaceholder("Type A Command Or Search...").fill("zzzznonexistentqueryxyz");

    await expect(palette.getByText("No Commands Found.")).toBeVisible();
    await expect(palette.getByRole("option")).toHaveCount(0);
  });

  test("selecting a navigation command navigates and closes the palette", async ({ app }) => {
    const palette = await app.openPalette();

    await palette.getByRole("option", { name: "Go To Workers" }).click();

    await expect(palette).toBeHidden();
    await expect(app.heading("Workers")).toBeVisible();
  });

  test("using a command records frecency and shows its use count on next open", async ({ app }) => {
    let palette = await app.openPalette();
    await expect(palette.locator("[data-command-badge]")).toHaveCount(0);
    await palette.getByRole("option", { name: "Go To Workers" }).click();
    await expect(palette).toBeHidden();

    palette = await app.openPalette();
    const usedOption = palette.getByRole("option", { name: "Go To Workers" });
    // Exactly "1": a substring match on the option would also pass for 10, 11, …
    await expect(usedOption.locator("[data-command-badge]")).toHaveText("1");
  });
});
