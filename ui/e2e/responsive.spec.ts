/*
 * Phone-width layout, run by the `mobile` project (390px wide): no page
 * scrolls sideways, and the header's icon-only nav never runs under the
 * account menu.
 */
import { expect, test } from "./fixtures";

// `ready` is text that shows the page's data has loaded, so the check measures
// the full layout rather than a spinner.
const PAGES: { path: string; heading: string; ready?: string }[] = [
  { path: "/apps", heading: "Apps", ready: "2 apps need attention" },
  { path: "/launch", heading: "Launch an app" },
  { path: "/apps/apps/docs-site", heading: "Docs Site" },
  {
    path: "/apps/apps/broken-app",
    heading: "Broken App",
    ready: "WorkloadReady failed: CrashLoopBackOff",
  },
  { path: "/apps/apps/docs-site/edit", heading: "Edit app" },
  { path: "/settings", heading: "Settings", ready: "ghcr.io/example" },
  { path: "/no-such-page", heading: "Page not found" },
];

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const { path, heading, ready } of PAGES) {
  test(`${path} fits a phone-width viewport`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    if (ready) await expect(page.getByText(ready).first()).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth, "the page scrolls horizontally").toBeLessThanOrEqual(innerWidth);

    // Tables sit in their own scroll container, so the page check alone would
    // miss columns hidden off the right edge.
    const tables = await page.evaluate(() =>
      [...document.querySelectorAll("table")].map((t) => {
        const box = t.parentElement as HTMLElement;
        return { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth };
      }),
    );
    for (const t of tables) {
      expect(t.scrollWidth, "a table scrolls horizontally").toBeLessThanOrEqual(t.clientWidth);
    }

    const header = page.getByRole("banner");
    const account = await header.getByRole("button", { name: /menu/i }).boundingBox();
    if (!account) throw new Error("the account menu button is not rendered");
    expect(account.x + account.width, "the account menu runs off-screen").toBeLessThanOrEqual(
      innerWidth,
    );

    const logo = await header.getByRole("link", { name: /go to homepage/i }).boundingBox();
    if (!logo) throw new Error("the logo is not rendered");
    expect(overlaps(logo, account), "the logo overlaps the account menu").toBe(false);
  });
}

// Pages render their chrome with skeletons for the pending data, which must fit too.
const SKELETONS: { path: string; hold: RegExp }[] = [
  { path: "/apps", hold: /^\/apps$/ },
  { path: "/apps/apps/docs-site", hold: /^\/apps\/apps\/docs-site$/ },
  { path: "/apps/apps/docs-site/edit", hold: /^\/apps\/apps\/docs-site$/ },
];

for (const { path, hold } of SKELETONS) {
  test(`${path} loading skeleton fits a phone-width viewport`, async ({ page, api }) => {
    const release = api.hold(hold);
    await page.goto(path);
    await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
    const { scrollWidth, innerWidth, tables } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      tables: [...document.querySelectorAll("table")].map((t) => {
        const box = t.parentElement as HTMLElement;
        return { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth };
      }),
    }));
    expect(scrollWidth, "the page scrolls horizontally").toBeLessThanOrEqual(innerWidth);
    for (const t of tables) {
      expect(t.scrollWidth, "a table scrolls horizontally").toBeLessThanOrEqual(t.clientWidth);
    }
    release();
  });
}
