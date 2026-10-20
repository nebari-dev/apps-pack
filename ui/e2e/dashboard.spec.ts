import { expect, test } from "./fixtures";

test.describe("dashboard", () => {
  test("Needs attention lists failed and restarting apps, linking to each", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("[data-slot=card]").filter({ hasText: "Needs attention" });
    const rows = card.getByRole("listitem");
    await expect(rows).toHaveCount(2);

    // Broken App is both Failed and restarting: one row, one combined badge.
    await expect(rows.nth(0)).toContainText("Broken App");
    await expect(rows.nth(0)).toContainText("Failed · 4 restarts");
    await expect(rows.nth(1)).toContainText("Docs Site");
    await expect(rows.nth(1)).toContainText("1 restart");
    await expect(card).not.toContainText("Sales Dashboard");

    await card.getByRole("link", { name: "Broken App" }).click();
    await expect(page).toHaveURL("/apps/apps/broken-app");
    await expect(page.getByRole("heading", { level: 1, name: "Broken App" })).toBeVisible();
  });

  test("Needs attention shows the all-clear when nothing restarts or fails", async ({
    page,
    api,
  }) => {
    api.apps = api.apps.filter((a) => a.status.phase !== "Failed");
    api.restarts = {};
    await page.goto("/");
    const card = page.locator("[data-slot=card]").filter({ hasText: "Needs attention" });
    await expect(card).toContainText("Everything is running — no restarts or failed apps.");
    await expect(card.getByRole("listitem")).toHaveCount(0);
  });

  test("the Metrics page is gone: no nav item, and /metrics is not found", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Metrics" })).toHaveCount(0);

    await page.goto("/metrics");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  });
});
