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

  test("leads with Needs attention, then one row of counts per phase", async ({ page }) => {
    await page.goto("/");
    const firstCard = page.locator("[data-slot=card]").first();
    await expect(firstCard).toContainText("Needs attention");
    await expect(firstCard.getByRole("table")).toBeVisible();

    const counts = page.getByLabel("App counts");
    await expect(counts).toHaveText(/^Failed1Running1Stopped1replicas ready1\/2namespaces2$/);
    await expect(page.getByText(/not running/i)).toHaveCount(0);
  });

  test("the Breakdown card switches tabs and labels inline uploads", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("[data-slot=card]").filter({ hasText: "Breakdown" });
    await expect(card.getByRole("tab", { name: "Status" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(card.getByRole("tabpanel", { name: "Status" })).toContainText("Failed");

    await card.getByRole("tab", { name: "Source" }).click();
    const panel = card.getByRole("tabpanel", { name: "Source" });
    await expect(panel).toContainText("Upload");
    await expect(panel).toContainText("Git");
    await expect(panel).toContainText("PVC");
    await expect(panel).not.toContainText("inline");

    await card.getByRole("tab", { name: "Namespace" }).click();
    await expect(card.getByRole("tabpanel", { name: "Namespace" })).toContainText("team-data");
  });

  test("Recently launched shows one status badge per app and links to all apps", async ({
    page,
  }) => {
    await page.goto("/");
    const list = page.getByRole("list", { name: "Recently launched apps" });
    const items = list.getByRole("listitem");
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText("Docs Site");
    await expect(items.first()).toContainText("apps · alice");
    await expect(items.first()).not.toContainText(/git/i);

    await page.getByRole("link", { name: "All apps" }).click();
    await expect(page).toHaveURL("/apps");
  });

  test("the Metrics page is gone: no nav item, and /metrics is not found", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Metrics" })).toHaveCount(0);

    await page.goto("/metrics");
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  });
});
