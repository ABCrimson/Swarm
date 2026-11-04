/// <reference lib="dom" />
// `page.evaluate` callbacks run in the browser: type them against the DOM lib.
import { expect, SwarmApp, test } from "./fixtures.ts";

// ── Stylesheet cascade ────────────────────────────────
//
// A custom `@layer` declared after `@import "tailwindcss"` lands after
// Tailwind's `utilities` layer, and a universal `* { padding: 0; margin: 0 }`
// reset in it would zero every utility and component padding in the app,
// so `utilities` must stay the last cascade layer.

test.describe("Stylesheet cascade", () => {
  test("Tailwind's utilities layer is the last cascade layer", async ({ app, page }) => {
    await expect(app.nav).toBeVisible();

    const layerOrder = await page.evaluate(() => {
      const order: string[] = [];
      const add = (name: string): void => {
        const top = name.split(".")[0] ?? name;
        if (!order.includes(top)) order.push(top);
      };
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSLayerStatementRule) rule.nameList.forEach(add);
          else if (rule instanceof CSSLayerBlockRule) add(rule.name);
        }
      }
      return order;
    });

    expect(layerOrder).toContain("utilities");
    expect(layerOrder.at(-1)).toBe("utilities");
  });

  test("component and utility padding is applied", async ({ app, page }) => {
    // Tailwind utilities on the nav list itself (`px-2.5 py-3`).
    await expect(app.nav).toHaveCSS("padding-left", "10px");
    await expect(app.nav).toHaveCSS("padding-top", "12px");

    // `.swarm-btn[data-size="sm"]` in @layer components.
    await app.goTo("Workers");
    await expect(page.getByRole("button", { name: "Spawn Worker" })).toHaveCSS(
      "padding-left",
      "10px",
    );
  });

  test("every Settings group after the first has the same pad above its rule", async ({ app }) => {
    // `py-6` on SettingsSection; only the column's first group drops its top
    // pad. Alert Thresholds sits inside its own <form>, so a first-child rule
    // that misses the wrapper leaves it flush on its rule.
    await app.goTo("Settings");
    const groups = [
      "AI Connectivity",
      "AI Model",
      "Visual Preferences",
      "Workers & AI",
      "Sessions & Logs",
      "Keybindings",
      "Alert Thresholds",
      "About",
    ];
    await expect(app.main.getByRole("region", { name: groups[0] })).toHaveCSS("padding-top", "0px");
    for (const name of groups.slice(1)) {
      await expect(app.main.getByRole("region", { name })).toHaveCSS("padding-top", "24px");
    }
  });

  test("tools are rule-divided grid rows, and a 64-character name stays in its column", async ({
    app,
    page,
  }) => {
    // ToolList rows carry no glass card (no blur, no fill), are divided by
    // a rule (`divide-y`: a bottom border on every row but the last) and
    // keep the name in a fixed 200px first column.
    await app.goTo("Tools");
    const rows = app.main.getByRole("article");
    await expect(rows.first()).toHaveCSS("display", "grid");
    await expect(rows.first()).toHaveCSS("backdrop-filter", "none");
    await expect(rows.first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(rows.first()).toHaveCSS("border-bottom-width", "1px");
    expect(await rows.first().evaluate((el) => getComputedStyle(el).gridTemplateColumns)).toMatch(
      /^200px /,
    );

    // A custom name may run to 64 characters with no natural break point.
    const name = `fetch_repository_documentation_index_${"x".repeat(27)}`;
    expect(name).toHaveLength(64);
    await app.main.getByRole("button", { name: "New Tool" }).click();
    await page.getByLabel("Tool Name").fill(name);
    await page.getByLabel("Description").fill("Fetches The Documentation Index");
    await page.getByRole("button", { name: "Save Tool" }).click();
    const heading = app.main.getByRole("heading", { level: 3, name });
    await expect(heading).toBeVisible();
    expect(await heading.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test.describe("with a log entry present", () => {
    // Particles on and WebGPU hidden: the particle background writes its
    // "unavailable" WARN entry to the Logs page.
    test.use({ reducedMotion: "no-preference" });

    test("the log level label is not clipped by its column", async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "gpu", {
          configurable: true,
          get: () => undefined,
        });
      });
      const app = new SwarmApp(page);
      await app.open();
      await app.goTo("Logs");
      const label = app.main.locator(".log-row__level .swarm-pill-label").first();
      await expect(app.main.locator(".log-row__level").first()).toHaveCSS("width", "56px");
      // The label text is Title Case; `.log-row__level` paints it uppercase.
      await expect(label).toHaveText("Warn");
      await expect(label).toHaveCSS("text-transform", "uppercase");
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    });
  });

  test.describe("under reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("the staggered entrance has no delays", async ({ app }) => {
      // AppShell staggers <main> with `delay-250`; under reduced motion it
      // must not sit invisible for that delay before snapping in.
      await expect(app.main).toHaveCSS("transition-delay", "0s");
      // Chromium serializes the 10µs duration as "1e-05s", Firefox and WebKit as "0.00001s".
      await expect(app.main).toHaveCSS("transition-duration", /^(1e-05|0\.00001)s$/);
      await expect(app.main).toHaveCSS("opacity", "1");
    });
  });
});
