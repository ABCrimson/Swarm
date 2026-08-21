import { expect, test } from "@playwright/test";

// ── Settings ──────────────────────────────────────────
//
// Frontend-shell coverage only — see docs/e2e.md. Settings reads/writes
// that touch the backend (`readConfig`/`writeConfig`/`setMaxWorkers`,
// the API key field, "Check For Updates") degrade gracefully without a
// Tauri bridge (`hasTransport()`/`isTauri()` false — see #lib/tauri) but
// their success paths aren't observable headless, so this suite covers
// what IS fully client-side: section rendering, model selection,
// keybinding capture, and number-field clamping.

async function gotoSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Page Navigation" })
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

test.describe("Settings", () => {
  test("renders every configuration section", async ({ page }) => {
    await gotoSettings(page);

    for (const heading of [
      "AI Connectivity",
      "AI Model",
      "Visual Preferences",
      "Workers & AI",
      "Sessions & Logs",
      "Keybindings",
      "Alert Thresholds",
      "About",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    }
  });

  test("the AI model catalog lets you switch the selected model", async ({ page }) => {
    await gotoSettings(page);

    const sonnetCard = page.getByRole("button", { name: /Claude Sonnet 5/ });
    const haikuCard = page.getByRole("button", { name: /Claude Haiku 4\.5/ });

    // "sonnet" is the default selection (see selectedModelAtom in #store/ui).
    await expect(sonnetCard).toHaveAttribute("aria-pressed", "true");
    await expect(haikuCard).toHaveAttribute("aria-pressed", "false");

    await haikuCard.click();

    await expect(haikuCard).toHaveAttribute("aria-pressed", "true");
    await expect(sonnetCard).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("Switched To Claude Haiku 4.5")).toBeVisible();
  });

  test("selecting the gated model shows a Project Glasswing warning instead of the plain switch toast", async ({
    page,
  }) => {
    await gotoSettings(page);

    await page.getByRole("button", { name: /Claude Mythos 5/ }).click();

    await expect(page.getByText("Claude Mythos 5 Requires Project Glasswing Access")).toBeVisible();
    await expect(page.getByText("Switched To Claude Mythos 5")).toHaveCount(0);
  });

  test("keybinding capture accepts a new binding", async ({ page }) => {
    await gotoSettings(page);

    const captureButton = page.getByRole("button", { name: "Change Shortcut For Command Palette" });
    await expect(captureButton).toHaveText("Ctrl+K");

    await captureButton.click();
    await expect(captureButton).toHaveText("Press Keys…");

    await page.keyboard.press("Alt+j");

    await expect(captureButton).toHaveText("Alt+J");
    await expect(page.getByText("Command Palette Bound To Alt+J")).toBeVisible();
  });

  test("keybinding capture rejects a binding already assigned elsewhere", async ({ page }) => {
    await gotoSettings(page);

    const graphToggleButton = page.getByRole("button", {
      name: "Change Shortcut For Graph / List Toggle",
    });
    await expect(graphToggleButton).toHaveText("Ctrl+Shift+G");

    await graphToggleButton.click();
    // "ctrl+k" is already the Command Palette's binding (DEFAULT_KEYBINDINGS).
    await page.keyboard.press("Control+k");

    await expect(page.getByText("Ctrl+K Is Already Assigned To Another Shortcut")).toBeVisible();
    await expect(graphToggleButton).toHaveText("Ctrl+Shift+G");
  });

  test("number fields clamp out-of-range input to the field's max on commit", async ({ page }) => {
    await gotoSettings(page);

    const streamLimit = page.getByLabel("AI Concurrent Stream Limit");
    await expect(streamLimit).toHaveValue("3"); // aiConcurrentLimit default (DEFAULT_APP_SETTINGS)

    await streamLimit.fill("999");
    await streamLimit.blur();

    // min=1, max=10 for this field (see Settings.tsx's NumberField usage).
    await expect(streamLimit).toHaveValue("10");
  });

  test("number fields clamp out-of-range input to the field's min on commit", async ({ page }) => {
    await gotoSettings(page);

    const streamLimit = page.getByLabel("AI Concurrent Stream Limit");
    await streamLimit.fill("0");
    await streamLimit.blur();

    await expect(streamLimit).toHaveValue("1");
  });
});
