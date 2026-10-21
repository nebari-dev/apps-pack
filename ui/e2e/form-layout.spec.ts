/*
 * Layout of the launch form: controls that share a row start on one top edge
 * whatever sits around them (an info tip or lock beside the label, help text
 * or an error below), and long registry names wrap between entries.
 */
import type { Page } from "@playwright/test";
import { APPS_DOMAIN } from "./data";
import { expect, test } from "./fixtures";

const REGISTRIES = ["ghcr.io/jbouder", "ghcr.io/nebari-dev"];

async function openImageForm(page: Page) {
  await page.route("**/api/v1/capabilities", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        appsDomain: APPS_DOMAIN,
        sourceTypes: ["git", "inline", "pvc", "image"],
        namespaces: ["apps", "team-data"],
        idleTimeoutMinutes: 30,
        imageRegistries: REGISTRIES,
      }),
    }),
  );
  await page.goto("/launch");
  await page.getByRole("combobox", { name: "App type" }).click();
  await page.getByRole("option", { name: "Container image" }).click();
  await expect(page.getByLabel("Image", { exact: true })).toBeVisible();
}

/** The top edge of each control, by id or by accessible name. */
async function tops(page: Page, ids: string[]): Promise<number[]> {
  return Promise.all(
    ids.map(async (id) => {
      const box = await page.locator(`#${id}`).boundingBox();
      if (!box) throw new Error(`#${id} is not visible`);
      return box.y;
    }),
  );
}

const ROWS: [string, string][] = [
  ["name", "displayName"],
  ["namespace", "kind"],
  ["imagePort", "imageRunAsUser"],
  ["imageCommand", "imageArgs"],
];

async function expectRowsAligned(page: Page) {
  // The App type trigger has no id of its own.
  await page.getByRole("combobox", { name: "App type" }).evaluate((el) => {
    el.id = "kind";
  });
  for (const row of ROWS) {
    const [a, b] = await tops(page, row);
    expect(Math.abs(a - b), `${row.join(" / ")} share a top edge`).toBeLessThanOrEqual(1);
  }
}

test.describe("launch form layout", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("controls in a row share a top edge", async ({ page }) => {
    await openImageForm(page);
    await expectRowsAligned(page);
  });

  test("errors under one control do not move its neighbour", async ({ page }) => {
    await openImageForm(page);
    await page.getByLabel("Port", { exact: true }).fill("80a");
    await page.getByRole("button", { name: "Launch app" }).click();
    await expect(page.locator("#name-error")).toBeVisible();
    await expectRowsAligned(page);
  });

  test("select triggers match the text inputs", async ({ page }) => {
    await openImageForm(page);
    const style = (sel: string) =>
      page.locator(sel).evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.height, s.paddingLeft, s.fontSize, s.borderRadius];
      });
    expect(await style("#namespace")).toEqual(await style("#name"));
  });

  test("registries wrap between entries, not inside one", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openImageForm(page);
    const help = page.locator("#imageRef-help span.font-mono");
    await expect(help).toHaveText(REGISTRIES.join(", "));
    for (const registry of REGISTRIES) {
      // The lines the registry's own text occupies.
      const lines = await help.evaluate((el, text) => {
        const node = el.firstChild as Text;
        const start = node.data.indexOf(text);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + text.length);
        return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      }, registry);
      expect(lines, `${registry} stays on one line`).toBe(1);
    }
  });
});
