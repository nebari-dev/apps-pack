/*
 * The Settings page: reached from the account menu, it shows the UI and API
 * versions, the caller's account, the cluster's settings and how to connect
 * an agent, all from the mocked apps-api.
 */
import { APPS_DOMAIN, BRANDING, UI_BUILD, UI_CONFIG, UI_VERSION } from "./data";
import { expect, test } from "./fixtures";

test("the account menu opens Settings, and no longer shows the version", async ({ page }) => {
  await page.goto("/");
  // The first page after a load keeps the browser's focus; wait for it.
  await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio", { name: "Dark mode" })).toBeVisible();
  await expect(menu).not.toContainText(UI_VERSION);
  await expect(menu).not.toContainText(UI_BUILD);

  await menu.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeFocused();
  await expect(page).toHaveTitle(/^Settings · /);
});

test("Settings is reachable from the account menu with the keyboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Apps" })).toBeVisible();
  await page.getByRole("button", { name: "Account menu" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemradio", { name: "Light mode" })).toBeFocused();
  // The theme picker, then Settings.
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeFocused();
});

test("shows the versions, account, cluster and agent details", async ({ page }) => {
  await page.goto("/settings");

  const about = page.getByRole("region", { name: "About" });
  // UI and API on the same release and image: both rows match, and no note.
  const values = about.locator("dd");
  await expect(values).toHaveText([UI_VERSION, UI_BUILD, UI_VERSION, UI_BUILD]);
  await expect(about.getByText(/different builds/)).toHaveCount(0);
  // /config is the API's: its version never stands in for the UI's.
  await expect(about).not.toContainText(UI_CONFIG.build ?? "");
  const bug = about.getByRole("link", { name: /Report a bug/ });
  const href = new URL((await bug.getAttribute("href")) ?? "");
  expect(href.origin + href.pathname).toBe("https://github.com/nebari-dev/apps-pack/issues/new");
  expect(href.searchParams.get("template")).toBe("bug-report.yml");
  expect(href.searchParams.get("version")).toBe(
    `UI ${UI_VERSION} (${UI_BUILD}), API ${UI_VERSION} (${UI_BUILD})`,
  );

  const account = page.getByRole("region", { name: "Your account" });
  await expect(account.getByText("anonymous")).toBeVisible();
  await expect(account.getByText("docs-team")).toBeVisible();

  const cluster = page.getByRole("region", { name: "Cluster" });
  await expect(cluster.getByText(APPS_DOMAIN)).toBeVisible();
  await expect(cluster.getByText("30 minutes")).toBeVisible();
  await expect(cluster.getByText("ghcr.io/example")).toBeVisible();

  const agent = page.getByRole("region", { name: "Connect an agent" });
  const origin = new URL(page.url()).origin;
  await expect(agent.getByText(`${origin}/mcp`, { exact: true })).toBeVisible();
  await expect(
    agent.getByText(`claude mcp add --transport http nebari-apps ${origin}/mcp`),
  ).toBeVisible();
});

test("copies the Claude Code command", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Copy Claude Code command" }).click();
  await expect(page.getByText("Copied the claude code command")).toBeVisible();
  const origin = new URL(page.url()).origin;
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `claude mcp add --transport http nebari-apps ${origin}/mcp`,
  );
});

test("says when image Apps are off and idling is off", async ({ page }) => {
  await page.route("**/api/v1/capabilities", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        appsDomain: APPS_DOMAIN,
        sourceTypes: ["git", "inline"],
        namespaces: ["apps"],
        idleTimeoutMinutes: 0,
        imageRegistries: [],
      }),
    }),
  );
  await page.goto("/settings");
  const cluster = page.getByRole("region", { name: "Cluster" });
  await expect(cluster.getByText("Image Apps are off")).toBeVisible();
  await expect(cluster.getByText(/^Off/)).toBeVisible();
});

test("notes when the UI and the API are on different builds", async ({ page, api }) => {
  api.version = { version: "9.9.9", build: "sha-newer" };
  await page.goto("/settings");
  const about = page.getByRole("region", { name: "About" });
  await expect(about.locator("dd")).toHaveText([UI_VERSION, UI_BUILD, "9.9.9", "sha-newer"]);
  await expect(about.getByText(/The UI and API are on different builds/)).toBeVisible();
  const href = new URL(
    (await about.getByRole("link", { name: /Report a bug/ }).getAttribute("href")) ?? "",
  );
  expect(href.searchParams.get("version")).toBe(
    `UI ${UI_VERSION} (${UI_BUILD}), API 9.9.9 (sha-newer)`,
  );
});

test("shows unknown for the UI build when /config.json has none", async ({ page }) => {
  const { build: _, ...branding } = BRANDING;
  await page.route("**/config.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(branding) }),
  );
  await page.goto("/settings");
  const about = page.getByRole("region", { name: "About" });
  await expect(about.locator("dd").nth(1)).toHaveText("unknown");
  await expect(about.locator("dd").nth(3)).toHaveText(UI_BUILD);
  await expect(about.getByText(/different builds/)).toHaveCount(0);
});
