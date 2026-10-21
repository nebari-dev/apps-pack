import type { Page } from "@playwright/test";
import { EVENTS } from "./data";
import { expect, test } from "./fixtures";

async function openDocsSite(page: Page) {
  await page.goto("/apps/apps/docs-site");
  await expect(page.getByRole("heading", { level: 1, name: "Docs Site" })).toBeVisible();
}

/** Presses Tab until `name` has focus; fails if the keyboard never reaches it. */
async function tabToButton(page: Page, name: string) {
  const target = page.getByRole("button", { name, exact: true });
  for (let i = 0; i < 30; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return target;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  return target;
}

test.describe("app detail", () => {
  test("shows the app's status, URL and health", async ({ page }) => {
    await openDocsSite(page);

    await expect(page.getByText("apps/docs-site · launched by alice")).toBeVisible();
    await expect(page.getByTestId("managers")).toHaveText(
      "Managed by alice (owner) · users: dave · groups: docs-team · admins · You can manage this app as an admin.",
    );
    await expect(
      page.getByRole("link", { name: "https://docs-site.apps.example.com" }),
    ).toBeVisible();
    await expect(page.getByText("of 1 ready", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Keycloak SSO at the gateway · restricted to groups: analytics"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "https://docs-site.apps.example.com",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    const health = page.getByRole("tabpanel", { name: "Health" });
    await expect(health.getByRole("listitem")).toHaveCount(3);
    await expect(health).toContainText("Passing: RoutingReady");
  });

  test("alerts with the reason a failed app is failing and links to its logs", async ({
    page,
    api,
  }) => {
    await page.goto("/apps/apps/broken-app");
    await expect(page.getByRole("heading", { level: 1, name: "Broken App" })).toBeVisible();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("WorkloadReady failed: CrashLoopBackOff");
    await expect(alert).toContainText("Back-off restarting container");
    await expect(page.getByText("CPU and memory are shown once the app is running.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open" })).toHaveCount(0);
    await expect(page.getByRole("tabpanel", { name: "Health" })).toContainText(
      "Failing: WorkloadReady · CrashLoopBackOff",
    );

    await alert.getByRole("button", { name: "View logs" }).click();
    await expect(page).toHaveURL("/apps/apps/broken-app?tab=logs");
    await expect(page.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");

    await alert.getByRole("button", { name: "Restart" }).click();
    await expect(page.getByText("Restarting Broken App")).toBeVisible();
    expect(api.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /apps/apps/broken-app/restart",
    ]);
  });

  test("offers Start, not Open, for a stopped app", async ({ page }) => {
    await page.goto("/apps/team-data/sales-dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Sales Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open" })).toHaveCount(0);
    await expect(page.getByText("CPU and memory are shown once the app is running.")).toBeVisible();

    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: /Restart/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  test("shows and filters the pod logs", async ({ page }) => {
    await openDocsSite(page);
    await page.getByRole("tab", { name: "Logs" }).click();

    const logs = page.getByRole("tabpanel", { name: "Logs" });
    const log = logs.getByRole("log", { name: "Pod logs" });
    await expect(log).toContainText("nginx: starting");
    await expect(log).toContainText("GET /missing.png 404");
    await log.focus();
    await expect(log).toBeFocused();

    const filter = logs.getByRole("textbox", { name: "Filter log lines" });
    await filter.fill("404");
    await expect(log).toContainText("GET /missing.png 404");
    await expect(log).not.toContainText("nginx: starting");

    await filter.fill("no-such-line");
    await expect(log).toContainText("No matching lines.");
  });

  test("shows events and the App manifest as YAML", async ({ page }) => {
    await openDocsSite(page);
    await page.getByRole("tab", { name: "Events" }).click();
    const events = page.getByRole("tabpanel", { name: "Events" });
    await expect(events).toContainText("Scheduled");
    await expect(events.locator("time")).toHaveAttribute("title", EVENTS[0].lastTimestamp);

    await page.getByRole("tab", { name: "Manifest" }).click();
    const manifest = page.getByRole("tabpanel", { name: "Manifest" });
    await expect(manifest).toContainText("kind: App");
    await expect(manifest).toContainText("apiVersion: apps.nebari.dev/v1alpha1");
    await expect(manifest).not.toContainText('"kind"');
  });

  test("shows an error for an app that does not exist", async ({ page }) => {
    await page.goto("/apps/apps/missing");
    await expect(page.getByRole("alert")).toContainText("Could not load app");
    await expect(page.getByRole("alert")).toContainText("App apps/missing not found");
  });
});

test.describe("app actions by keyboard", () => {
  test("stop, and restart from the More menu, are operable with the keyboard", async ({
    page,
    api,
  }) => {
    await openDocsSite(page);

    const stop = await tabToButton(page, "Stop");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Stopped Docs Site")).toBeVisible();

    await tabToButton(page, "More actions");
    await page.keyboard.press("Enter");
    const restart = page.getByRole("menuitem", { name: "Restart" });
    await expect(restart).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Restarting Docs Site")).toBeVisible();

    await expect(stop).toBeVisible();
    expect(api.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /apps/apps/docs-site/stop",
      "POST /apps/apps/docs-site/restart",
    ]);
  });

  test("the delete dialog traps focus, cancels with Escape and confirms with Enter", async ({
    page,
    api,
  }) => {
    await openDocsSite(page);

    const more = await tabToButton(page, "More actions");
    await page.keyboard.press("Enter");
    // The menu takes focus once it opens; End before then goes nowhere.
    await expect(page.getByRole("menuitem", { name: "Restart" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Delete Docs Site?" });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByLabel("Type docs-site to confirm");
    await expect(confirm).toBeFocused();

    // Escape closes it and puts focus back on the menu button that opened it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(more).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Restart" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(confirm).toBeFocused();
    // Tab cycles inside the dialog.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      await expect(dialog.locator(":focus")).toHaveCount(1);
    }
    await confirm.focus();
    await page.keyboard.type("docs-site");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL("/");
    expect(api.requests).toEqual([{ method: "DELETE", path: "/apps/apps/docs-site", body: null }]);
  });

  test("the account menu opens, switches the theme and closes with the keyboard", async ({
    page,
  }) => {
    await openDocsSite(page);
    const trigger = page.getByRole("button", { name: "Account menu" });
    await trigger.focus();

    await page.keyboard.press("Enter");
    const dark = page.getByRole("menuitemradio", { name: "Dark mode" });
    await expect(dark).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "Light mode" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(dark).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expect(dark).toHaveAttribute("aria-checked", "true");

    await page.keyboard.press("Escape");
    await expect(dark).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});
