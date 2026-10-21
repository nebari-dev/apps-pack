import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.describe("apps list", () => {
  test("lists every app with its status", async ({ page }) => {
    await page.goto("/apps");
    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();

    const rows = page.getByRole("row");
    // A header row plus one row per app.
    await expect(rows).toHaveCount(4);
    const docs = rows.filter({ has: page.getByRole("link", { name: "Docs Site", exact: true }) });
    await expect(docs).toContainText("Running");
    await expect(docs).toContainText("1/1");
    await expect(rows.filter({ hasText: "Sales Dashboard" })).toContainText("Stopped");
    await expect(rows.filter({ hasText: "Broken App" })).toContainText("Failed");
  });

  test("puts the most severe app first and explains the failure", async ({ page }) => {
    await page.goto("/apps");
    const rows = page.getByRole("row");
    await expect(rows.nth(1)).toContainText("Broken App");
    await expect(rows.nth(2)).toContainText("Docs Site");
    await expect(rows.nth(3)).toContainText("Sales Dashboard");

    const broken = rows.nth(1);
    await expect(broken).toContainText("CrashLoopBackOff");
    await expect(broken).toContainText("broken-app · apps");
    await expect(broken.getByText("PVC", { exact: true })).toBeVisible();
    await expect(rows.nth(3).getByText("Python", { exact: true })).toBeVisible();
    await expect(rows.nth(3).getByText("Upload", { exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /Namespace/ })).toHaveCount(0);

    await broken.getByRole("link", { name: "Logs" }).click();
    await expect(page).toHaveURL("/apps/apps/broken-app?tab=logs");
    await expect(page.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  });

  test("opens an app by clicking anywhere in its row", async ({ page }) => {
    await page.goto("/apps");
    const sales = page.getByRole("row").filter({ hasText: "Sales Dashboard" });
    await sales.getByText("bob", { exact: true }).click();
    await expect(page).toHaveURL("/apps/team-data/sales-dashboard");
  });

  test("offers only the bulk actions that apply to the selection", async ({ page, api }) => {
    await page.goto("/apps");
    const sales = page.getByRole("row").filter({ hasText: "Sales Dashboard" });
    await sales.getByRole("checkbox").click();
    await expect(page).toHaveURL("/apps");
    const start = page.getByRole("button", { name: "Start", exact: true });
    const stop = page.getByRole("button", { name: "Stop", exact: true });
    await expect(start).toBeVisible();
    await expect(stop).toHaveCount(0);

    await page.getByRole("checkbox", { name: "Select all" }).click();
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(page.getByText("Stopped 2 app(s)")).toBeVisible();
    expect(api.requests.map((r) => r.path).sort()).toEqual([
      "/apps/apps/broken-app/stop",
      "/apps/apps/docs-site/stop",
    ]);
  });

  test("focuses the search with / and clears an empty result", async ({ page }) => {
    await page.goto("/apps");
    await expect(page.getByRole("link", { name: "Docs Site", exact: true })).toBeVisible();
    const search = page.getByPlaceholder("Search by name, source, status…");
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await page.keyboard.type("no-such-app");
    await expect(page.getByText("No apps match your filter.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("row")).toHaveCount(4);
    await expect(search).toHaveValue("");
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
    await page.getByRole("link", { name: "Docs Site", exact: true }).click();

    await expect(page).toHaveURL("/apps/apps/docs-site");
    const heading = page.getByRole("heading", { level: 1, name: "Docs Site" });
    await expect(heading).toBeFocused();
    await expect(page).toHaveTitle("docs-site · Nebari Apps");
  });

  test("stops and starts apps from their row", async ({ page, api }) => {
    await page.goto("/apps");
    const docs = page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name: "Docs Site", exact: true }) });
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
    await expect(page.getByRole("link", { name: "Docs Site", exact: true })).toBeVisible();
  });
});

test.describe("apps as the home page", () => {
  test("/ lands on the apps list, with no Dashboard or Metrics page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL("/apps");
    await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
    await expect(page.getByText("Web applications running on this Nebari cluster.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Launch app" })).toBeVisible();
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("link", { name: /Dashboard/ })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Metrics" })).toHaveCount(0);

    await page.goto("/metrics");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  });

  test("shows onboarding without the filters on an empty cluster", async ({ page, api }) => {
    api.apps = [];
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "No apps yet" })).toBeVisible();
    await expect(page.getByPlaceholder("Search by name, source, status…")).toHaveCount(0);
    await expect(page.getByText(/need attention/)).toHaveCount(0);
  });

  test("hides the Mine chip when auth is off", async ({ page }) => {
    await page.goto("/apps");
    await expect(page.getByRole("link", { name: "Docs Site", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Mine/ })).toHaveCount(0);
  });
});

test.describe("needs attention", () => {
  const banner = (page: Page) => page.locator("[data-slot=alert]").filter({ hasText: "need" });

  test("counts failed and restarting apps and filters the list to them", async ({ page }) => {
    await page.goto("/apps");
    await expect(banner(page)).toContainText("2 apps need attention");
    await expect(banner(page)).toContainText("1 failed, 1 restarting");

    const rows = page.getByRole("row");
    await expect(rows).toHaveCount(4);
    await page.getByPlaceholder("Search by name, source, status…").fill("sales");
    await banner(page).getByRole("button", { name: "Show" }).click();

    // Applying it clears the search and keeps only Broken App and Docs Site.
    await expect(page.getByPlaceholder("Search by name, source, status…")).toHaveValue("");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText("Broken App");
    await expect(rows.nth(1)).toContainText("4 restarts");
    await expect(rows.nth(2)).toContainText("Docs Site");
    await expect(rows.nth(2)).toContainText("1 restart");
    const chip = page.getByRole("button", { name: /^Needs attention/ });
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(banner(page).getByRole("button", { name: "Show" })).toHaveCount(0);

    await page.getByRole("button", { name: /^All/ }).click();
    await expect(rows).toHaveCount(4);
  });

  test("is absent when nothing fails or restarts", async ({ page, api }) => {
    api.apps = api.apps.filter((a) => a.status.phase !== "Failed");
    api.restarts = {};
    await page.goto("/apps");
    await expect(page.getByRole("link", { name: "Docs Site", exact: true })).toBeVisible();
    await expect(page.locator("[data-slot=alert]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Needs attention/ })).toHaveCount(0);
  });

  test("says so when restart counts fail to load, never claiming the all-clear", async ({
    page,
    api,
  }) => {
    api.failMetrics = { status: 503, detail: "metrics unavailable" };
    await page.goto("/apps");
    await expect(banner(page)).toContainText("1 app needs attention");
    await expect(banner(page)).toContainText("Restart counts are unavailable");

    api.apps = api.apps.filter((a) => a.status.phase !== "Failed");
    await page.reload();
    const alert = page.locator("[data-slot=alert]");
    await expect(alert).toContainText("Could not check apps for restarts");
    await expect(alert).toContainText("metrics unavailable");
  });
});

test.describe("open action", () => {
  test("opens a running app's URL in a new tab, and only a running app's", async ({ page }) => {
    await page.goto("/apps");
    const row = (name: string) =>
      page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });
    const open = row("Docs Site").getByRole("link", { name: "Open Docs Site" });
    await expect(open).toHaveAttribute("href", "https://docs-site.apps.example.com");
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
    await expect(row("Sales Dashboard").getByRole("link", { name: /^Open/ })).toHaveCount(0);
    await expect(row("Broken App").getByRole("link", { name: /^Open/ })).toHaveCount(0);
  });
});
