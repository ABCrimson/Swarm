import { expect, test } from "@playwright/test";

// ── Command Palette ──────────────────────────────────
//
// Frontend-shell coverage only — see docs/e2e.md for the no-backend
// boundary. Navigation commands work headless because they only touch
// client-side Jotai state (`currentPageAtom`); `worker:spawn` and
// `session:snapshot` are exercised only insofar as the palette records
// their usage in frecency — the underlying `spawnWorker`/`createSnapshot`
// calls degrade to no-ops without a Tauri bridge (`hasTransport()` false).

test.describe("Command Palette", () => {
  test("opens with Ctrl+K, labeled as the SWARM Command Palette", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "SWARM Command Palette" });
    await expect(palette).toBeVisible({ timeout: 5_000 });
    await expect(palette.getByPlaceholder("Type A Command Or Search...")).toBeFocused();
  });

  test("Escape closes the palette", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "SWARM Command Palette" });
    await expect(palette).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("typing a specific query filters the list down to matching commands", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "SWARM Command Palette" });

    await palette.getByPlaceholder("Type A Command Or Search...").fill("spawn worker");

    await expect(palette.getByRole("option", { name: "Spawn Worker" })).toBeVisible();
    // Unrelated commands whose label/keywords share no fuzzy-orderable
    // characters with "spawn worker" are excluded outright by the
    // scorer (see modern-cmdk's default-scorer: a null score removes
    // the item from `filteredIds` entirely) — not just re-ordered.
    await expect(palette.getByRole("option", { name: "Go To Metrics" })).toHaveCount(0);
    await expect(palette.getByRole("option", { name: "Toggle Sidebar" })).toHaveCount(0);
  });

  test("a query matching nothing shows the empty state", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "SWARM Command Palette" });

    await palette.getByPlaceholder("Type A Command Or Search...").fill("zzzznonexistentqueryxyz");

    await expect(palette.getByText("No Commands Found.")).toBeVisible();
    await expect(palette.getByRole("option")).toHaveCount(0);
  });

  test("selecting a navigation command navigates and closes the palette", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "SWARM Command Palette" });

    await palette.getByRole("option", { name: "Go To Workers" }).click();

    await expect(palette).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
  });

  test("using a command records frecency and shows a usage badge on next open", async ({
    page,
  }) => {
    await page.goto("/");

    await page.keyboard.press("Control+k");
    let palette = page.getByRole("dialog", { name: "SWARM Command Palette" });
    await palette.getByRole("option", { name: "Go To Workers" }).click();
    await expect(palette).toBeHidden();

    await page.keyboard.press("Control+k");
    palette = page.getByRole("dialog", { name: "SWARM Command Palette" });
    const usedOption = palette.getByRole("option").filter({ hasText: "Go To Workers" });
    await expect(usedOption).toBeVisible();
    await expect(usedOption).toContainText("1");
  });
});
