/*
 * Phone-width layout, run by the `mobile` project (390px wide): no page
 * scrolls sideways, and the header's icon-only nav never runs under the
 * account menu.
 */
import { expect, test } from "./fixtures";

// `ready` is text that shows the page's data has loaded, so the check measures
// the full layout rather than a spinner.
const PAGES: { path: string; heading: string; ready?: string }[] = [
  { path: "/", heading: "Dashboard", ready: "broken-app · apps" },
  { path: "/apps", heading: "Apps", ready: "docs-site · apps" },
  { path: "/launch", heading: "Launch an app" },
  { path: "/apps/apps/docs-site", heading: "Docs Site" },
  {
    path: "/apps/apps/broken-app",
    heading: "Broken App",
    ready: "WorkloadReady failed: CrashLoopBackOff",
  },
  { path: "/apps/apps/docs-site/edit", heading: "Edit app" },
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

    const links = await header.getByRole("navigation").getByRole("link").all();
    expect(links.length).toBeGreaterThan(0);
    const seen: Box[] = [];
    for (const link of links) {
      const box = await link.boundingBox();
      if (!box) throw new Error("a nav link is not rendered");
      expect(overlaps(box, account), "a nav link overlaps the account menu").toBe(false);
      for (const other of seen) expect(overlaps(box, other), "nav links overlap").toBe(false);
      seen.push(box);
    }
  });
}
