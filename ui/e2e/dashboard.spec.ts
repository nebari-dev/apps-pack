import { expect, test } from "./fixtures";

test.describe("dashboard", () => {
  test("Needs attention lists failed and restarting apps in a table, linking to each", async ({
    page,
  }) => {
    await page.goto("/");
    const table = page.getByRole("table", { name: "Apps that need attention" });
    const rows = table.getByRole("row");
    // Header plus Broken App (Failed and restarting: one row) and Docs Site.
    await expect(rows).toHaveCount(3);

    const broken = rows.nth(1);
    await expect(broken).toContainText("Broken App");
    await expect(broken).toContainText("broken-app · apps");
    await expect(broken).toContainText("CrashLoopBackOff");
    await expect(broken).toHaveAttribute("data-phase", "Failed");
    await expect(broken.getByRole("cell").nth(2)).toHaveText("4");
    await expect(broken.getByRole("button", { name: "Restart Broken App" })).toBeVisible();

    const docs = rows.nth(2);
    await expect(docs).toContainText("Docs Site");
    await expect(docs.getByRole("cell").nth(2)).toHaveText("1");
    await expect(docs.getByRole("button", { name: /Restart/ })).toHaveCount(0);
    await expect(table).not.toContainText("Sales Dashboard");

    await broken.getByRole("link", { name: "Broken App", exact: true }).click();
    await expect(page).toHaveURL("/apps/apps/broken-app");
    await expect(page.getByRole("heading", { level: 1, name: "Broken App" })).toBeVisible();
  });

  test("the Logs link opens the app's Logs tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Logs for Docs Site" }).click();
    await expect(page).toHaveURL("/apps/apps/docs-site?tab=logs");
    await expect(page.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("GET /index.html 200")).toBeVisible();
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
    await expect(card.getByRole("table")).toHaveCount(0);
  });

  test("the Metrics page is gone: no nav item, and /metrics is not found", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Metrics" })).toHaveCount(0);

    await page.goto("/metrics");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  });
});
