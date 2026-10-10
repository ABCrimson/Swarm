import { expect, SwarmApp, test } from "./fixtures.ts";

// WKWebView (macOS) and WebKitGTK (Linux) ship no Temporal; `src/boot.ts`
// installs temporal-polyfill there before the app loads. Chromium has a
// native Temporal, so the first spec deletes it to stand in for WebKit.
// A native method's source reads "[native code]"; the polyfill's does not,
// which tells the two apart in the dev server and the production bundle alike.

/** Whether the page's global `Temporal` is the engine's own. */
const isNative = (): boolean => Temporal.Now.instant.toString().includes("[native code]");

test.describe("Temporal polyfill", () => {
  test("loads where Temporal is missing, and the app's Temporal paths run on it", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(globalThis, "Temporal");
    });
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));

    const app = new SwarmApp(page);
    await app.open();
    expect(await page.evaluate(isNative)).toBe(false);

    // The palette persists a command's frecency through Temporal on use
    // and reads it back through Temporal on the next open.
    const palette = await app.openPalette();
    await palette.getByRole("option", { name: "Go To Logs" }).click();
    await expect(app.heading("Logs")).toBeVisible();
    await app.openPalette();
    await page.keyboard.press("Escape");
    // The chart axes and log timestamps format through Temporal.
    await app.goTo("Metrics");
    await app.goTo("Logs");

    expect(errors).toEqual([]);
  });

  test("leaves a native Temporal in place", async ({ page }) => {
    await new SwarmApp(page).open();
    expect(await page.evaluate(isNative)).toBe(true);
  });
});
