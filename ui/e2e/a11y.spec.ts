/*
 * axe over every page of the built UI, in both themes. Unlike the jsdom check
 * in tests/pages/a11y.test.tsx this sees real layout and computed colors, so it
 * covers color contrast, and it loads each page's lazy chunk from the bundle.
 */
import type { Page } from "@playwright/test";
import {
  expect,
  expectNoCriticalOrSeriousA11yViolations,
  expectResolvedTheme,
  type Theme,
  test,
} from "./fixtures";

// `ready` is text that shows the page's data has loaded (on the apps list, the
// Needs attention banner, which waits on both the apps and the restart counts).
const PAGES: { name: string; path: string; heading: string; ready?: string }[] = [
  { name: "apps list", path: "/apps", heading: "Apps", ready: "2 apps need attention" },
  { name: "launch form", path: "/launch", heading: "Launch an app" },
  { name: "app detail", path: "/apps/apps/docs-site", heading: "Docs Site" },
  {
    name: "failed app detail",
    path: "/apps/apps/broken-app",
    heading: "Broken App",
    ready: "WorkloadReady failed: CrashLoopBackOff",
  },
  { name: "edit form", path: "/apps/apps/docs-site/edit", heading: "Edit app" },
  { name: "not found", path: "/no-such-page", heading: "Page not found" },
];

// Pages whose content loads behind a skeleton: `hold` is the API request held
// open, `label` the status announced while it is, `loaded` a role that shows
// the real content replaced the placeholder.
const LOADING: {
  name: string;
  path: string;
  hold: RegExp;
  label: string;
  loaded: Parameters<Page["getByRole"]>;
}[] = [
  {
    name: "apps list",
    path: "/apps",
    hold: /^\/apps$/,
    label: "Loading apps",
    loaded: ["link", { name: "Docs Site" }],
  },
  {
    name: "app detail",
    path: "/apps/apps/docs-site",
    hold: /^\/apps\/apps\/docs-site$/,
    label: "Loading app",
    loaded: ["heading", { level: 1, name: "Docs Site" }],
  },
  {
    name: "edit form",
    path: "/apps/apps/docs-site/edit",
    hold: /^\/apps\/apps\/docs-site$/,
    label: "Loading app",
    loaded: ["heading", { level: 1, name: "Edit app" }],
  },
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

    for (const { name, path, hold, label, loaded } of LOADING) {
      test(`${name} loading skeleton has no critical or serious violations @a11y`, async ({
        page,
        api,
      }) => {
        const release = api.hold(hold);
        await page.goto(path);
        await expect(page.getByRole("status").filter({ hasText: label })).toBeAttached();
        const busy = page.locator('[aria-busy="true"]');
        await expect(busy).toHaveAttribute("aria-hidden", "true");
        await expect(busy.locator('[data-slot="skeleton"]').first()).toBeVisible();
        await expectResolvedTheme(page, theme);
        await expectNoCriticalOrSeriousA11yViolations(page);

        release();
        await expect(page.getByRole(...loaded).first()).toBeVisible();
        await expect(busy).toHaveCount(0);
      });
    }

    test(`app detail logs tab has no critical or serious violations @a11y`, async ({ page }) => {
      await page.goto("/apps/apps/docs-site");
      await page.getByRole("tab", { name: "Logs" }).click();
      await expect(page.getByText("GET /index.html 200")).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`app detail More menu has no critical or serious violations @a11y`, async ({ page }) => {
      await page.goto("/apps/apps/docs-site");
      await page.getByRole("button", { name: "More actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`launch form with a validation error has no critical or serious violations @a11y`, async ({
      page,
    }) => {
      await page.goto("/launch");
      const name = page.getByLabel("Name", { exact: true });
      await name.fill("Not Valid");
      await page.keyboard.press("Tab");
      await expect(name).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#name-error")).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });

    test(`launch form for a container image has no critical or serious violations @a11y`, async ({
      page,
    }) => {
      await page.goto("/launch");
      await page.getByRole("combobox", { name: "App type" }).click();
      await page.getByRole("option", { name: "Container image" }).click();
      await expect(page.getByLabel("Image", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Launch app" }).click();
      await expect(page.locator("#imageRef-error")).toBeVisible();
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
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Delete" }).click();
      await expect(page.getByRole("dialog", { name: "Delete Docs Site?" })).toBeVisible();
      await expectNoCriticalOrSeriousA11yViolations(page);
    });
  });
}
