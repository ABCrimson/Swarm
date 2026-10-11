import { expect, test } from "./fixtures.ts";

// src/boot.ts loads the app through import(); when that fails it shows a
// start-failure message in #root instead of a blank window. The app's main
// module has a different URL per server: `/src/main.tsx` on the dev server,
// the hashed `/assets/main-<hash>.js` chunk on the production build that
// `vite preview` serves (CI). The route covers both, so the test fails the
// import on either.
const MAIN_MODULE = /\/(src\/main\.tsx|assets\/main-[\w-]+\.js)(\?|$)/;

test("a failed app module load shows the start-failure message", async ({ page }) => {
  await page.route(MAIN_MODULE, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "SWARM Could Not Start" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
});
