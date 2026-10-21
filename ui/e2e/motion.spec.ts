/*
 * Motion: pages ease in on navigation (not on the first paint), data that
 * replaces a skeleton crossfades in, overlays use the registry's token-driven
 * transitions, and prefers-reduced-motion turns all of it off.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** The element wrapping the routed page inside <main>. */
const routed = (page: Page) => page.locator("#main > div");

const animationName = (el: Locator) => el.evaluate((node) => getComputedStyle(node).animationName);

test.describe("with motion allowed", () => {
  test("the first page paints without an entrance; a navigated-to page eases in", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Docs Site", exact: true })).toBeVisible();
    expect(await animationName(routed(page))).toBe("none");

    await page.getByRole("link", { name: "Docs Site", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Docs Site" })).toBeVisible();
    expect(await animationName(routed(page))).toBe("nebari-slide-up-fade");
  });

  test("rows that replace the skeleton crossfade in", async ({ page, api }) => {
    const release = api.hold(/^\/apps$/);
    await page.goto("/");
    await expect(page.locator('[data-slot="skeleton"]').first()).toBeVisible();
    release();
    await expect(page.getByRole("link", { name: "Docs Site", exact: true })).toBeVisible();
    expect(await animationName(page.locator("tbody"))).toBe("nebari-fade-in");
  });

  test("dialogs transition with the theme's duration token", async ({ page }) => {
    await page.goto("/apps/apps/docs-site");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const duration = await dialog.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration).toBe("0.2s");
  });
});

test.describe("with prefers-reduced-motion: reduce", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("pages, data and skeletons do not animate", async ({ page, api }) => {
    const release = api.hold(/^\/apps$/);
    await page.goto("/");
    const skeleton = page.locator('[data-slot="skeleton"]').first();
    await expect(skeleton).toBeVisible();
    expect(await animationName(skeleton)).toBe("none");
    release();
    await expect(page.getByRole("link", { name: "Docs Site", exact: true })).toBeVisible();
    expect(await animationName(page.locator("tbody"))).toBe("none");

    await page.getByRole("link", { name: "Docs Site", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Docs Site" })).toBeVisible();
    expect(await animationName(routed(page))).toBe("none");
    await page.getByRole("tab", { name: "Events" }).click();
    expect(await animationName(page.getByRole("tabpanel"))).toBe("none");
  });

  test("dialogs open without a transition", async ({ page }) => {
    await page.goto("/apps/apps/docs-site");
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const duration = await dialog.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration).toBe("0s");
  });
});
