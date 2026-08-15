import { expect, test } from "@playwright/test";

// ── Dialogs ───────────────────────────────────────────
//
// Frontend-shell coverage only — see docs/e2e.md. The Spawn Worker
// dialog opens and renders fully without a backend: `agentProbe()`
// short-circuits to `{ available: false, detail: "No Backend Transport
// Available." }` the instant `hasTransport()` is false (see #lib/tauri),
// so the Claude Code provider option is deterministically disabled here
// — not flaky, not skipped. Actually spawning a worker (the "Spawn
// Worker" submit action) is out of scope: `spawnWorker`/`agentSpawn`
// resolve to `null` with no observable worker created.

async function openSpawnDialog(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Page Navigation" })
    .getByRole("button", { name: "Workers" })
    .click();
  await page.getByRole("button", { name: "Spawn Worker" }).click();
}

test.describe("Spawn Worker Dialog", () => {
  test("opens from the Workers page toolbar with the expected fields", async ({ page }) => {
    await openSpawnDialog(page);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Spawn Worker" })).toBeVisible();

    await expect(dialog.getByRole("radio", { name: "Webview Anthropic" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Claude Code" })).toBeVisible();
    await expect(dialog.getByText("Working Directory")).toBeVisible();
  });

  test("Claude Code provider is disabled with the measured probe reason (no backend transport)", async ({
    page,
  }) => {
    await openSpawnDialog(page);
    const dialog = page.getByRole("dialog");

    const claudeCodeRadio = dialog.getByRole("radio", { name: "Claude Code" });
    await expect(claudeCodeRadio).toBeDisabled();
    await expect(
      dialog.getByText("Claude Code Unavailable — No Backend Transport Available."),
    ).toBeVisible();
  });

  test("working directory falls back to no-isolation copy when nothing is persisted", async ({
    page,
  }) => {
    await openSpawnDialog(page);
    const dialog = page.getByRole("dialog");

    await expect(
      dialog.getByText("No Project Root — Spawns Without Worktree Isolation"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Escape closes the dialog and restores focus to the trigger button", async ({ page }) => {
    await openSpawnDialog(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Spawn Worker" })).toBeFocused();
  });

  test("clicking outside the panel closes the dialog", async ({ page }) => {
    await openSpawnDialog(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Click the overlay well away from the centered panel.
    await page.mouse.click(5, 5);

    await expect(dialog).toBeHidden();
  });

  test("selecting Claude Code-specific fields is unreachable while the provider is disabled", async ({
    page,
  }) => {
    await openSpawnDialog(page);
    const dialog = page.getByRole("dialog");

    // Model Alias / Trust Tier fields only render once the Claude Code
    // radio is actually selected — which a disabled radio can't be.
    await expect(dialog.getByLabel("Model Alias")).toHaveCount(0);
    await expect(dialog.getByText("Trust Tier")).toHaveCount(0);
  });
});
