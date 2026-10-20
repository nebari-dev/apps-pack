import { expect, test } from "./fixtures";

test.describe("apps list", () => {
  test("lists every app with its status", async ({ page }) => {
    await page.goto("/apps");
    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();

    const rows = page.getByRole("row");
    // A header row plus one row per app.
    await expect(rows).toHaveCount(4);
    const docs = rows.filter({ has: page.getByRole("link", { name: "Docs Site" }) });
    await expect(docs).toContainText("Running");
    await expect(docs).toContainText("1/1");
    await expect(rows.filter({ hasText: "Sales Dashboard" })).toContainText("Stopped");
    await expect(rows.filter({ hasText: "Broken App" })).toContainText("Failed");
  });

  test("filters by search and by status", async ({ page }) => {
    await page.goto("/apps");
    const rows = page.getByRole("row");
    await expect(rows).toHaveCount(4);

    await page.getByPlaceholder("Search by name, source, status…").fill("sales");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Sales Dashboard");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(rows).toHaveCount(4);

    await page.getByRole("button", { name: /^Failed/ }).click();
    await expect(page.getByRole("button", { name: /^Failed/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Broken App");
  });

  test("opens an app's page and moves focus to its heading", async ({ page }) => {
    await page.goto("/apps");
    await page.getByRole("link", { name: "Docs Site" }).click();

    await expect(page).toHaveURL("/apps/apps/docs-site");
    const heading = page.getByRole("heading", { level: 1, name: "Docs Site" });
    await expect(heading).toBeFocused();
    await expect(page).toHaveTitle("docs-site · Nebari Apps");
  });

  test("stops and starts apps from their row", async ({ page, api }) => {
    await page.goto("/apps");
    const docs = page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name: "Docs Site" }) });
    const sales = page.getByRole("row").filter({ hasText: "Sales Dashboard" });

    await docs.getByRole("button", { name: "Stop app" }).click();
    await expect(page.getByText("Stopped Docs Site")).toBeVisible();
    await sales.getByRole("button", { name: "Start app" }).click();
    await expect(page.getByText("Started Sales Dashboard")).toBeVisible();

    expect(api.requests).toEqual([
      { method: "POST", path: "/apps/apps/docs-site/stop", body: null },
      { method: "POST", path: "/apps/team-data/sales-dashboard/start", body: null },
    ]);
  });

  test("shows onboarding when there are no apps", async ({ page, api }) => {
    api.apps = [];
    await page.goto("/apps");

    await expect(page.getByRole("heading", { name: "No apps yet" })).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await page.getByRole("link", { name: "Launch an app" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Launch an app" })).toBeFocused();
  });

  test("shows the API's error, not an empty list, and recovers on retry", async ({ page, api }) => {
    api.failList = { status: 503, detail: "apps-api is unavailable" };
    await page.goto("/apps");

    const alert = page.getByRole("alert").filter({ hasText: "Could not load apps" });
    await expect(alert).toContainText("apps-api is unavailable");
    await expect(page.getByRole("heading", { name: "No apps yet" })).toHaveCount(0);

    api.failList = null;
    await alert.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("link", { name: "Docs Site" })).toBeVisible();
  });
});
