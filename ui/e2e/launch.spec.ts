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
          landingPage: { enabled: false },
          source: { type: "git", git: { url: "https://github.com/example/my-site", ref: "main" } },
        },
      },
    ]);
  });

  test("launches a container image", async ({ page, api }) => {
    await openLaunchForm(page);

    await page.getByLabel("Name", { exact: true }).fill("dash");
    await page.getByLabel("Display name").fill("Dash");
    await page.getByRole("combobox", { name: "App type" }).click();
    await page.getByRole("option", { name: "Container image" }).click();
    await expect(page.getByText("Allowed registries: ghcr.io/example")).toBeVisible();
    await page.getByLabel("Image", { exact: true }).fill("ghcr.io/example/dash:1.2.3");
    await page.getByLabel("Port", { exact: true }).fill("8501");
    await page.getByRole("button", { name: "Launch app" }).click();

    await expect(page).toHaveURL("/apps/apps/dash");
    expect(api.requests).toMatchObject([
      {
        method: "POST",
        path: "/apps",
        body: {
          name: "dash",
          runtime: { pixiTask: "" },
          source: { type: "image", image: { reference: "ghcr.io/example/dash:1.2.3", port: 8501 } },
        },
      },
    ]);
  });

  test("sends secrets write-only, apart from the runtime", async ({ page, api }) => {
    await openLaunchForm(page);

    await page.getByLabel("Name", { exact: true }).fill("llm-site");
    await page.getByLabel("Display name").fill("LLM Site");
    await page.getByRole("tab", { name: "Git" }).click();
    await page.getByLabel("Repository URL").fill("https://github.com/example/llm-site");
    await expect(page.getByText(/Put API keys, tokens and passwords/)).toBeVisible();
    await page.getByRole("button", { name: "Add secret" }).click();
    await page.getByLabel("Secret 1 name").fill("OPENAI_API_KEY");
    const value = page.getByLabel("Value of secret OPENAI_API_KEY");
    await expect(value).toHaveAttribute("type", "password");
    await value.fill("sk-test");
    await page.getByRole("button", { name: "Launch app" }).click();

    await expect(page).toHaveURL("/apps/apps/llm-site");
    expect(api.requests).toMatchObject([
      {
        method: "POST",
        path: "/apps",
        body: {
          runtime: { replicas: 1, env: [], resources: null, pixiTask: "" },
          secrets: { OPENAI_API_KEY: "sk-test" },
        },
      },
    ]);
  });

  test("restricts a private app to groups", async ({ page, api }) => {
    await openLaunchForm(page);

    await page.getByLabel("Name", { exact: true }).fill("team-site");
    await page.getByLabel("Display name").fill("Team Site");
    await page.getByRole("tab", { name: "Git" }).click();
    await page.getByLabel("Repository URL").fill("https://github.com/example/team-site");
    await page.getByLabel("Allowed groups").fill("analysts , finance,");
    await page.getByLabel("Manager users").fill("dave");
    await page.getByLabel("Manager groups").fill("web-team");
    // The landing-page option is locked: a note, not a switch.
    await expect(page.getByRole("switch", { name: /landing page/ })).toHaveCount(0);
    await expect(page.getByText(/Changing this here is not available yet/)).toBeVisible();
    await page.getByRole("button", { name: "Launch app" }).click();

    await expect(page).toHaveURL("/apps/apps/team-site");
    await expect(
      page.getByText("Keycloak SSO at the gateway · restricted to groups: analysts, finance"),
    ).toBeVisible();
    await expect(page.getByTestId("managers")).toHaveText(
      "Managed by users: dave · groups: web-team · admins",
    );
    expect(api.requests).toMatchObject([
      {
        method: "POST",
        path: "/apps",
        body: {
          access: {
            public: false,
            groups: ["analysts", "finance"],
            managers: { users: ["dave"], groups: ["web-team"] },
            subdomain: "team-site",
          },
          landingPage: { enabled: false },
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

  test("validates on blur or submit, with each message under its field", async ({ page, api }) => {
    await openLaunchForm(page);
    const launch = page.getByRole("button", { name: "Launch app" });
    const name = page.getByLabel("Name", { exact: true });
    const nameError = page.locator("#name-error");

    // A fresh form is clean and the button is usable.
    await expect(page.locator("[aria-invalid]")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(launch).toBeEnabled();

    await name.fill("Not Valid");
    // The subdomain mirrors a slug of the name, so the preview is a valid host.
    await expect(page.getByLabel("Subdomain")).toHaveValue("not-valid");
    await expect(page.getByText("https://not-valid.apps.example.com")).toBeVisible();
    await expect(name).not.toHaveAttribute("aria-invalid");
    await page.keyboard.press("Tab");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(nameError).toHaveText("Name must be lowercase letters, digits, and hyphens.");
    await expect(name).toHaveAccessibleDescription(
      /Name must be lowercase letters, digits, and hyphens\.$/,
    );

    await name.fill("valid-name");
    await expect(name).not.toHaveAttribute("aria-invalid");
    await expect(nameError).toHaveCount(0);

    // Submitting with problems shows them all and focuses the first.
    await page.getByRole("tab", { name: "Git" }).click();
    await launch.click();
    await expect(page.locator("#displayName-error")).toHaveText("Give the app a display name.");
    await expect(page.locator("#gitUrl-error")).toHaveText("Enter the git repository URL.");
    await expect(page.getByLabel("Display name")).toBeFocused();
    await expect(page.getByText("2 problems to fix")).toBeAttached();
    expect(api.requests).toEqual([]);
  });

  test("keeps replicas and resources under Advanced, with a pressed preset", async ({
    page,
    api,
  }) => {
    await openLaunchForm(page);
    // Collapsed by default: only environment variables show in Runtime.
    await expect(page.getByLabel("Replicas")).toBeHidden();
    await expect(page.getByRole("button", { name: "Medium" })).toBeHidden();
    await page.getByText("Advanced", { exact: true }).click();
    await expect(page.getByLabel("Replicas")).toBeVisible();

    const medium = page.getByRole("button", { name: "Medium" });
    await expect(medium).toHaveAttribute("aria-pressed", "false");
    await medium.click();
    await expect(medium).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("CPU request")).toHaveValue("250m");

    await page.getByLabel("Name", { exact: true }).fill("sized");
    await page.getByLabel("Display name").fill("Sized");
    await page.getByRole("tab", { name: "Git" }).click();
    await page.getByLabel("Repository URL").fill("https://github.com/example/sized");
    await page.getByRole("button", { name: "Launch app" }).click();
    await expect(page).toHaveURL("/apps/apps/sized");
    expect(api.requests).toMatchObject([
      {
        body: {
          runtime: {
            resources: {
              requests: { cpu: "250m", memory: "512Mi" },
              limits: { cpu: "500m", memory: "1Gi" },
            },
          },
        },
      },
    ]);
  });

  test("Cancel goes back to the apps list", async ({ page }) => {
    await openLaunchForm(page);
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL("/apps");
  });

  test("the footer fits a phone-width screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLaunchForm(page);
    const launch = page.getByRole("button", { name: "Launch app" });
    await launch.scrollIntoViewIfNeeded();
    await expect(launch).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Cancel" })).toBeInViewport({ ratio: 1 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
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
    // Then the PVC info button, the panel, then the upload drop zone's file input.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "About PVC" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel", { name: "Upload" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(/Drop a \.zip/)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Git" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "About PVC" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tabpanel", { name: "Git" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Repository URL")).toBeFocused();
    await page.keyboard.type("https://github.com/example/kb-site");

    // On through the rest of the form to the submit button, typing into the
    // access lists on the way.
    const launch = page.getByRole("button", { name: "Launch app" });
    const visited: string[] = [];
    for (
      let i = 0;
      i < 40 && !(await launch.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press("Tab");
      const id = await focused.getAttribute("id");
      if (id) visited.push(id);
      if (id === "groups") await page.keyboard.type("analysts");
    }
    await expect(launch).toBeFocused();
    expect(visited).toEqual(expect.arrayContaining(["groups", "subdomain"]));
    expect(visited.indexOf("subdomain")).toBe(visited.indexOf("groups") + 1);
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
          access: { groups: ["analysts"] },
          source: { type: "git", git: { url: "https://github.com/example/kb-site" } },
        },
      },
    ]);
  });
});
