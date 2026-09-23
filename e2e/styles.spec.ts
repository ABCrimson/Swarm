/// <reference lib="dom" />
// `page.evaluate` callbacks run in the browser: type them against the DOM lib.
import { expect, test } from "@playwright/test";

// ── Stylesheet cascade ────────────────────────────────
//
// Guards the regression where a custom `@layer` declared after
// `@import "tailwindcss"` was appended AFTER Tailwind's `utilities`
// layer, and its universal `* { padding: 0; margin: 0 }` reset silently
// zeroed every utility and component padding in the app.

test.describe("Stylesheet cascade", () => {
  test("Tailwind's utilities layer is the last cascade layer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Page Navigation" })).toBeVisible();

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

  test("component and utility padding is applied", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Page Navigation" });

    // Tailwind utilities on the nav list itself (`px-2.5 py-3`).
    await expect(nav).toHaveCSS("padding-left", "10px");
    await expect(nav).toHaveCSS("padding-top", "12px");

    // `.swarm-btn[data-size="sm"]` in @layer components.
    await nav.getByRole("button", { name: "Workers" }).click();
    await expect(page.getByRole("button", { name: "Spawn Worker" })).toHaveCSS(
      "padding-left",
      "10px",
    );
  });
});
