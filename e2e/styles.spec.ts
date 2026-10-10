/// <reference lib="dom" />
// `page.evaluate` callbacks run in the browser: type them against the DOM lib.
import { expect, test } from "./fixtures.ts";

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
