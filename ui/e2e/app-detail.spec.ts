import type { Page } from "@playwright/test";
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
  test("shows the app's status, URL and conditions", async ({ page }) => {
    await openDocsSite(page);

    await expect(page.getByText("apps/docs-site · launched by alice")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "https://docs-site.apps.example.com" }),
    ).toBeVisible();
    await expect(page.getByText("1/1", { exact: true })).toBeVisible();
    const conditions = page.getByRole("tabpanel", { name: "Conditions" });
    await expect(conditions.getByRole("listitem")).toHaveCount(3);
    await expect(conditions).toContainText("Passing: RoutingReady");
  });

  test("shows the reason a failed app is failing", async ({ page }) => {
    await page.goto("/apps/apps/broken-app");
    await expect(page.getByRole("heading", { level: 1, name: "Broken App" })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "Conditions" })).toContainText(
      "Failing: WorkloadReady · CrashLoopBackOff",
    );
  });

  test("shows and filters the pod logs", async ({ page }) => {
    await openDocsSite(page);
    await page.getByRole("tab", { name: "Logs" }).click();

    const logs = page.getByRole("tabpanel", { name: "Logs" });
    await expect(logs).toContainText("nginx: starting");
    await expect(logs).toContainText("GET /missing.png 404");

    await logs.getByPlaceholder("Filter lines…").fill("404");
    await expect(logs).toContainText("GET /missing.png 404");
    await expect(logs).not.toContainText("nginx: starting");

    await logs.getByPlaceholder("Filter lines…").fill("no-such-line");
    await expect(logs).toContainText("No matching lines.");
  });

  test("shows events and the App manifest", async ({ page }) => {
    await openDocsSite(page);
    await page.getByRole("tab", { name: "Events" }).click();
    await expect(page.getByRole("tabpanel", { name: "Events" })).toContainText("Scheduled");

    await page.getByRole("tab", { name: "Manifest" }).click();
    await expect(page.getByRole("tabpanel", { name: "Manifest" })).toContainText('"kind": "App"');
  });

  test("shows an error for an app that does not exist", async ({ page }) => {
    await page.goto("/apps/apps/missing");
    await expect(page.getByRole("alert")).toContainText("Could not load app");
    await expect(page.getByRole("alert")).toContainText("App apps/missing not found");
  });
});

test.describe("app actions by keyboard", () => {
  test("stop and restart are operable with the keyboard", async ({ page, api }) => {
    await openDocsSite(page);

    const stop = await tabToButton(page, "Stop");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Stopped Docs Site")).toBeVisible();

    await tabToButton(page, "Restart");
    await page.keyboard.press("Space");
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

    const remove = await tabToButton(page, "Delete");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Delete Docs Site?" });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByLabel("Type docs-site to confirm");
    await expect(confirm).toBeFocused();

    // Escape closes it and puts focus back on the button that opened it.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();

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

    await expect(page).toHaveURL("/apps");
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
