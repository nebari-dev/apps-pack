/*
 * The apps list screenshot used by the README
 * (docs/src/assets/screenshots/apps-list.png). Run `npm run build` and then
 * `npm run screenshot`; it uses the e2e suite's mocked apps-api with the
 * made-up apps below, so the image holds no real data.
 */
import { fileURLToPath } from "node:url";
import { expect, test } from "../e2e/fixtures";
import type { App } from "../src/lib/types";

const OUTPUT = fileURLToPath(
  new URL("../../docs/src/assets/screenshots/apps-list.png", import.meta.url),
);
const DOMAIN = "apps.example.com";

const ready = (replicas: number): App["status"] => ({
  phase: replicas > 0 ? "Running" : "Stopped",
  url: "",
  message: replicas > 0 ? `${replicas}/${replicas} replicas ready` : "Scaled to zero",
  replicas: { desired: replicas, ready: replicas },
  conditions: [],
});

function app(
  name: string,
  displayName: string,
  namespace: string,
  source: App["source"],
  replicas: number,
  owner: string,
  createdAt: string,
  pixiTask?: string,
): App {
  return {
    name,
    namespace,
    displayName,
    description: "",
    thumbnail: "",
    owner,
    createdAt,
    source,
    runtime: { replicas, ...(pixiTask ? { pixiTask } : {}) },
    access: { public: false, subdomain: name },
    status: { ...ready(replicas), url: `https://${name}.${DOMAIN}` },
  };
}

const APPS: App[] = [
  app(
    "team-handbook",
    "Team Handbook",
    "apps",
    { type: "git", git: { url: "https://github.com/example/handbook", ref: "main" } },
    2,
    "alice",
    "2026-10-14T09:00:00Z",
  ),
  app("docs-site", "Docs Site", "apps", { type: "inline" }, 1, "alice", "2026-10-15T10:30:00Z"),
  app(
    "sales-dashboard",
    "Sales Dashboard",
    "team-data",
    { type: "inline" },
    1,
    "bob",
    "2026-10-16T14:00:00Z",
    "start",
  ),
  app(
    "notebook-gallery",
    "Notebook Gallery",
    "team-data",
    { type: "pvc", pvc: { claimName: "notebooks" } },
    1,
    "grace",
    "2026-10-17T08:15:00Z",
  ),
  app(
    "forecast-explorer",
    "Forecast Explorer",
    "team-data",
    { type: "git", git: { url: "https://github.com/example/forecast", ref: "main" } },
    1,
    "bob",
    "2026-10-18T16:45:00Z",
    "serve",
  ),
  app(
    "release-notes",
    "Release Notes",
    "apps",
    { type: "inline" },
    0,
    "alice",
    "2026-10-19T11:20:00Z",
  ),
];

test("apps list screenshot", async ({ page, api }) => {
  api.apps = APPS;
  api.restarts = {};
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/apps");
  await expect(page.getByRole("row")).toHaveCount(APPS.length + 1);
  await page.screenshot({ path: OUTPUT, animations: "disabled", caret: "hide" });
});
