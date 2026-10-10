import { expect, test } from "./fixtures.ts";

// src/boot.ts loads the app through import(); when that fails it shows a
// start-failure message in #root instead of a blank window. The app module
// is /src/main.tsx on the dev server and a hashed /assets/main-<hash>.js
// chunk in the preview build CI serves (see playwright.config.ts).
test("a failed app module load shows the start-failure message", async ({ page }) => {
  await page.route(/\/(?:src\/main\.tsx|assets\/main-[\w-]+\.js)(?:\?|$)/, (route) =>
    route.fulfill({ status: 500, body: "" }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "SWARM Could Not Start" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});
