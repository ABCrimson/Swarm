/// <reference lib="dom" />
// `evaluate` callbacks run in the browser: type them against the DOM lib.
import { expect, test } from "./fixtures.ts";

// ── Settings ──────────────────────────────────────────
//
// Frontend-shell coverage only — see docs/e2e.md. Settings reads/writes
// that touch the backend (`readConfig`/`writeConfig`/`setMaxWorkers`,
// the API key field, "Check For Updates") degrade gracefully without a
// Tauri bridge (`hasTransport()`/`isTauri()` false — see #lib/tauri) but
// their success paths aren't observable headless, so this suite covers
// what IS fully client-side: section rendering, model selection,
// keybinding capture, and number-field clamping.

test.beforeEach(async ({ app }) => {
  await app.goTo("Settings");
});

test.describe("Settings", () => {
  test("renders every configuration section", async ({ app }) => {
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
      await expect(app.main.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    }
  });

  test("the AI model catalog lets you switch the selected model", async ({ page }) => {
    const models = page.getByRole("radiogroup", { name: "AI Model" });
    const sonnetCard = models.getByRole("radio", { name: "Claude Sonnet 5.5" });
    const haikuCard = models.getByRole("radio", { name: "Claude Haiku 5.5" });

    // "sonnet" is the default selection (see selectedModelAtom in #store/ui).
    await expect(sonnetCard).toBeChecked();
    await expect(haikuCard).not.toBeChecked();

    // The radio itself is visually hidden; its card (a <label>) takes the click.
    await models.getByText("Claude Haiku 5.5", { exact: true }).click();

    await expect(haikuCard).toBeChecked();
    await expect(sonnetCard).not.toBeChecked();
    await expect(page.getByText("Switched To Claude Haiku 5.5")).toBeVisible();
  });

  test("selecting the gated model shows a Project Glasswing warning instead of the plain switch toast", async ({
    page,
  }) => {
    // Matched by family, not the exact label, so a point release (e.g.
    // "Claude Mythos 5.1") does not break the spec.
    await page
      .getByRole("radiogroup", { name: "AI Model" })
      .getByText(/^Claude Mythos \d[\d.]*$/)
      .click();

    await expect(
      page.getByText(/^Claude Mythos \d[\d.]* Requires Project Glasswing Access$/),
    ).toBeVisible();
    await expect(page.getByText(/^Switched To Claude Mythos/)).toHaveCount(0);
  });

  test("keybinding capture accepts a new binding", async ({ page }) => {
    const captureButton = page.getByRole("button", { name: "Change Shortcut For Command Palette" });
    await expect(captureButton).toHaveText("Ctrl+K");

    await captureButton.click();
    await expect(captureButton).toHaveText("Press Keys…");

    await page.keyboard.press("Alt+j");

    await expect(captureButton).toHaveText("Alt+J");
    await expect(page.getByText("Command Palette Bound To Alt+J")).toBeVisible();
  });

  test("keybinding capture rejects a binding already assigned elsewhere", async ({ page }) => {
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
    const streamLimit = page.getByLabel("AI Concurrent Stream Limit");
    await expect(streamLimit).toHaveValue("3"); // aiConcurrentLimit default (DEFAULT_APP_SETTINGS)

    await streamLimit.fill("999");
    await streamLimit.blur();

    // min=1, max=10 for this field (see Settings.tsx's NumberField usage).
    await expect(streamLimit).toHaveValue("10");
  });

  test("number fields clamp out-of-range input to the field's min on commit", async ({ page }) => {
    const streamLimit = page.getByLabel("AI Concurrent Stream Limit");
    await streamLimit.fill("0");
    await streamLimit.blur();

    await expect(streamLimit).toHaveValue("1");
  });
});

test.describe("Settings accessibility", () => {
  test("switches, model cards and number fields show a keyboard focus ring", async ({ page }) => {
    const particles = page.getByRole("switch", { name: "Particle Background" });
    await particles.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(particles).toBeFocused();
    await expect(particles).toHaveCSS("outline-style", "solid");

    // The model radio is visually hidden; its card draws the ring.
    const selected = page.getByRole("radio", { name: "Claude Sonnet 5.5" });
    // Reached by Tab, as above. Not by an arrow key: after the first arrow step
    // WebKit moves focus to the next radio without :focus-visible on it.
    await selected.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(selected).toBeFocused();
    const card = page.locator("label[data-model-id]:has(input:focus-visible)");
    await expect(card).toHaveCSS("outline-style", "solid");

    const streamLimit = page.getByLabel("AI Concurrent Stream Limit");
    await streamLimit.focus();
    await expect(streamLimit).toHaveCSS("outline-style", "solid");
  });

  test("the primary buttons use dark text on the accent", async ({ page }) => {
    // --color-void text on --color-plasma: ~11.8:1, not the old 1.54:1 near-white.
    const button = page.getByRole("button", { name: "Check For Updates" });
    const [text, background, voidColor, plasma] = await button.evaluate((el) => {
      const probe = (value: string): string => {
        const span = document.createElement("span");
        span.style.color = value;
        document.body.append(span);
        const color = getComputedStyle(span).color;
        span.remove();
        return color;
      };
      const style = getComputedStyle(el);
      return [
        style.color,
        style.backgroundColor,
        probe("var(--color-void)"),
        probe("var(--color-plasma)"),
      ];
    });
    expect(text).toBe(voidColor);
    expect(background).toBe(plasma);
  });

  test("an inverted threshold pair is refused with an inline error", async ({ page }) => {
    await page.getByRole("button", { name: "Edit Thresholds" }).click();
    await page.getByLabel("CPU Warning").fill("95");
    await page.getByRole("button", { name: "Save Thresholds" }).click();

    await expect(
      page.getByRole("alert").filter({ hasText: "CPU Warning Must Be Below CPU Critical" }),
    ).toBeVisible();
    await expect(page.getByLabel("CPU Warning")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("CPU Critical")).toHaveAttribute("aria-invalid", "true");
    // Only the offending pair is marked invalid.
    await expect(page.getByLabel("Memory Warning")).not.toHaveAttribute("aria-invalid");
  });
});
