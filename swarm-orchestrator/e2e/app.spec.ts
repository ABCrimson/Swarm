import { test, expect } from "@playwright/test";

test.describe("SWARM Orchestrator smoke tests", () => {
  test("app loads and displays the dashboard", async ({ page }) => {
    await page.goto("/");

    // Wait for the app to fully render — look for SWARM branding or main heading
    await expect(
      page.getByText(/swarm/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("sidebar navigation is present and clickable", async ({ page }) => {
    await page.goto("/");

    // The sidebar should be visible with navigation elements
    const sidebar = page.getByRole("navigation");
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
  });

  test("command palette opens with Ctrl+K", async ({ page }) => {
    await page.goto("/");

    // Wait for the app to be interactive
    await page.waitForLoadState("networkidle");

    // Open command palette with keyboard shortcut
    await page.keyboard.press("Control+k");

    // Command palette should become visible — look for the dialog
    const palette = page.getByRole("dialog");

    await expect(palette).toBeVisible({ timeout: 5_000 });
  });
});
