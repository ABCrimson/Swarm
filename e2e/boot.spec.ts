import { expect, test } from "./fixtures.ts";

// src/boot.ts loads the app through import(); when that fails it shows a
// start-failure message in #root instead of a blank window.
test("a failed app module load shows the start-failure message", async ({ page }) => {
  await page.route(/\/src\/main\.tsx(\?|$)/, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "SWARM Could Not Start" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});
