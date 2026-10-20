import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function openLaunchForm(page: Page) {
  await page.goto("/launch");
  await expect(page.getByRole("heading", { level: 1, name: "Launch an app" })).toBeVisible();
}

test.describe("launch form", () => {
  test("launches a git app and opens its page", async ({ page, api }) => {
    await openLaunchForm(page);

    await page.getByLabel("Name", { exact: true }).fill("my-site");
    await page.getByLabel("Display name").fill("My Site");
    await page.getByRole("tab", { name: "Git" }).click();
    await page.getByLabel("Repository URL").fill("https://github.com/example/my-site");
    // The subdomain follows the name until it is edited.
    await expect(page.getByLabel("Subdomain")).toHaveValue("my-site");
    await page.getByRole("button", { name: "Launch app" }).click();

    await expect(page).toHaveURL("/apps/apps/my-site");
    await expect(page.getByRole("heading", { level: 1, name: "My Site" })).toBeVisible();
    expect(api.requests).toEqual([
      {
        method: "POST",
        path: "/apps",
        body: {
          name: "my-site",
          namespace: "apps",
          displayName: "My Site",
          runtime: { replicas: 1, env: [], resources: null, pixiTask: "" },
          access: { public: false, groups: [], subdomain: "my-site" },
          source: { type: "git", git: { url: "https://github.com/example/my-site", ref: "main" } },
        },
      },
    ]);
  });

  test("uploads a site as multipart with the manifest", async ({ page, api }) => {
    await openLaunchForm(page);

    await page.getByLabel("Name", { exact: true }).fill("upload-site");
    await page.getByLabel("Display name").fill("Upload Site");
    await page.getByLabel(/Drop a \.zip/).setInputFiles({
      name: "index.html",
      mimeType: "text/html",
      buffer: Buffer.from("<h1>hello</h1>"),
    });
    await page.getByRole("button", { name: "Launch app" }).click();

    await expect(page).toHaveURL("/apps/apps/upload-site");
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      path: "/apps/upload",
      body: { name: "upload-site", namespace: "apps", displayName: "Upload Site" },
    });
  });

  test("shows the first problem and blocks submit until it is fixed", async ({ page, api }) => {
    await openLaunchForm(page);
    const launch = page.getByRole("button", { name: "Launch app" });
    const error = page.getByRole("alert");
    const name = page.getByLabel("Name", { exact: true });

    await expect(error).toHaveText("Give the app a name.");
    await expect(launch).toBeDisabled();

    await name.fill("Not Valid");
    await expect(error).toHaveText("Name must be lowercase letters, digits, and hyphens.");
    // The message is tied to the control it is about.
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAccessibleDescription(
      "Name must be lowercase letters, digits, and hyphens.",
    );

    await name.fill("valid-name");
    await expect(name).not.toHaveAttribute("aria-invalid");
    await expect(error).toHaveText("Give the app a display name.");

    await page.getByLabel("Display name").fill("Valid");
    await expect(error).toHaveText("Choose a .zip or .html file to upload.");

    await page.getByRole("tab", { name: "Git" }).click();
    await expect(error).toHaveText("Enter the git repository URL.");
    await page.getByLabel("Repository URL").fill("https://github.com/example/site");
    await expect(error).toHaveCount(0);
    await expect(launch).toBeEnabled();
    expect(api.requests).toEqual([]);
  });

  test("can be filled and submitted with the keyboard alone", async ({ page, api }) => {
    await openLaunchForm(page);
    const focused = page.locator(":focus");

    // Skip link first, then straight into the form in reading order.
    await page.keyboard.press("Tab");
    await expect(focused).toHaveAccessibleName("Skip to content");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await page.keyboard.type("kb-site");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Display name")).toBeFocused();
    await page.keyboard.type("Keyboard Site");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Description")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Thumbnail URL")).toBeFocused();

    // Namespace: a select operated with the arrow keys.
    await page.keyboard.press("Tab");
    await expect(focused).toHaveAccessibleName(/Namespace/);
    await page.keyboard.press("Enter");
    // The list opens with focus on the current value; wait for it before moving.
    await expect(page.getByRole("option", { name: "apps" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: "team-data" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("combobox", { name: /Namespace/ })).toHaveText(/team-data/);
    await expect(page.getByRole("combobox", { name: /Namespace/ })).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(focused).toHaveAccessibleName(/App type/);

    // Source tabs: Tab lands on the selected tab, the arrows move between tabs.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tab", { name: "Upload" })).toBeFocused();
    // Then the panel, then the upload drop zone's file input.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel", { name: "Upload" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(/Drop a \.zip/)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Git" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel", { name: "Git" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Repository URL")).toBeFocused();
    await page.keyboard.type("https://github.com/example/kb-site");

    // On through the rest of the form to the submit button.
    const launch = page.getByRole("button", { name: "Launch app" });
    for (
      let i = 0;
      i < 40 && !(await launch.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
    }
    await expect(launch).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL("/apps/team-data/kb-site");
    expect(api.requests).toMatchObject([
      {
        method: "POST",
        path: "/apps",
        body: {
          name: "kb-site",
          namespace: "team-data",
          displayName: "Keyboard Site",
          source: { type: "git", git: { url: "https://github.com/example/kb-site" } },
        },
      },
    ]);
  });
});
