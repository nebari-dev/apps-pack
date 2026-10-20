/*
 * axe over every page of the built UI, in both themes. Unlike the jsdom check
 * in tests/pages/a11y.test.tsx this sees real layout and computed colors, so it
 * covers color contrast, and it loads each page's lazy chunk from the bundle.
 */
import {
  expect,
  expectNoCriticalOrSeriousA11yViolations,
  expectResolvedTheme,
  type Theme,
  test,
} from "./fixtures";

// `ready` is text that shows the page's data has loaded (on the dashboard, the
// Failed row of the Needs attention table).
const PAGES: { name: string; path: string; heading: string; ready?: string }[] = [
  { name: "dashboard", path: "/", heading: "Dashboard", ready: "broken-app · apps" },
  { name: "apps list", path: "/apps", heading: "Apps" },
  { name: "launch form", path: "/launch", heading: "Launch an app" },
  { name: "app detail", path: "/apps/apps/docs-site", heading: "Docs Site" },
  { name: "edit form", path: "/apps/apps/docs-site/edit", heading: "Edit app" },
  { name: "not found", path: "/no-such-page", heading: "Page not found" },
];

for (const theme of ["light", "dark"] satisfies Theme[]) {
  test.describe(`${theme} theme`, () => {
    test.use({ theme });

    for (const { name, path, heading, ready } of PAGES) {
      test(`${name} has no critical or serious violations @a11y`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expectResolvedTheme(page, theme);
        if (ready) await expect(page.getByText(ready)).toBeVisible();
        await expectNoCriticalOrSeriousA11yViolations(page);
      });
    }

    test(`app detail logs tab has no critical or serious violations @a11y`, async ({ page }) => {
      await page.goto("/apps/apps/docs-site");
      await page.getByRole("tab", { name: "Logs" }).click();
      await expect(page.getByText("GET /index.html 200")).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`launch form with a validation error has no critical or serious violations @a11y`, async ({
      page,
    }) => {
      await page.goto("/launch");
      await page.getByLabel("Name", { exact: true }).fill("Not Valid");
      await expect(page.getByRole("alert")).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`empty apps list has no critical or serious violations @a11y`, async ({ page, api }) => {
      api.apps = [];
      await page.goto("/apps");
      await expect(page.getByRole("heading", { name: "No apps yet" })).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`apps list error state has no critical or serious violations @a11y`, async ({
      page,
      api,
    }) => {
      api.failList = { status: 500, detail: "apps-api is unavailable" };
      await page.goto("/apps");
      await expect(page.getByText("Could not load apps")).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`account menu has no critical or serious violations @a11y`, async ({ page }) => {
      await page.goto("/apps");
      await page.getByRole("button", { name: "Account menu" }).click();
      await expect(page.getByRole("menuitemradio", { name: "Dark mode" })).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`delete confirmation dialog has no critical or serious violations @a11y`, async ({
      page,
    }) => {
      await page.goto("/apps/apps/docs-site");
      await page.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByRole("dialog", { name: "Delete Docs Site?" })).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });
  });
}
