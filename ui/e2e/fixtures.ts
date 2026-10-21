/*
 * Shared Playwright fixtures: a mocked apps-api, the branding config, a theme
 * switch and the axe check. Every spec imports `test` and `expect` from here.
 *
 * The suite runs the production build under `vite preview`, which has no
 * apps-api behind it: every /api/** request is answered by `page.route` from
 * the `api` fixture's state. Tests change that state (the app list, a failure)
 * before navigating, and read `api.requests` to assert what the UI sent.
 */
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page, type Request } from "@playwright/test";
import type { ApiVersion, App, AppCreate } from "../src/lib/types";
import {
  API_VERSION,
  appMetricsFor,
  BRANDING,
  CAPABILITIES,
  clusterMetricsFor,
  DEFAULT_APPS,
  EVENTS,
  LOGS,
  ME,
  RESTARTS,
  UI_CONFIG,
} from "./data";

/** A request the UI made that changes something (anything but GET). */
export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface MockApi {
  /** What GET /apps returns, and what the per-App routes look up. */
  apps: App[];
  /** When set, GET /apps fails with this status and detail. */
  failList: { status: number; detail: string } | null;
  logs: string;
  /** What GET /version returns. */
  version: ApiVersion;
  /** When set, GET /analytics/metrics fails with this status and detail. */
  failMetrics: { status: number; detail: string } | null;
  /** Container restarts per App ("namespace/name") for GET /analytics/metrics and an App's metrics. */
  restarts: Record<string, number>;
  /** False: the cluster has no metrics server (an App's metrics carry no usage). */
  metricsServer: boolean;
  /** Mutating requests, in the order they arrived. */
  requests: RecordedRequest[];
  /**
   * Holds GET requests whose path (after /api/v1) matches `path` until the
   * returned function is called, so a test can see the page while it loads.
   */
  hold: (path: RegExp) => () => void;
}

export type Theme = "light" | "dark";

/** localStorage key of the theme preference (src/main.tsx, index.html). */
const THEME_STORAGE_KEY = "nebari-apps:themeMode";

const json = (status: number, body: unknown) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function requestBody(request: Request): unknown {
  const type = request.headers()["content-type"] ?? "";
  if (type.includes("application/json")) return request.postDataJSON();
  // Uploads are multipart: keep the manifest part, which is JSON.
  const raw = request.postData() ?? "";
  const manifest = raw.match(/name="manifest"\r\n\r\n(.*?)\r\n--/s)?.[1];
  return manifest ? JSON.parse(manifest) : raw || null;
}

/** The App the API would return for a create: the request plus a fresh status. */
function created(body: Omit<AppCreate, "source"> & { source?: AppCreate["source"] }): App {
  return {
    name: body.name,
    namespace: body.namespace,
    displayName: body.displayName,
    description: body.description ?? "",
    thumbnail: "",
    owner: "",
    createdAt: "2026-10-19T13:00:00Z",
    source: body.source ?? { type: "inline" },
    runtime: body.runtime,
    access: body.access,
    landingPage: body.landingPage,
    status: { phase: "Pending", url: "", message: "", conditions: [] },
  };
}

async function installApiRoutes(page: Page, api: MockApi, held: Held[]) {
  await page.route("**/config.json", (route) => route.fulfill(json(200, BRANDING)));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");

    if (method !== "GET") {
      api.requests.push({ method, path, body: requestBody(request) });
    } else {
      await Promise.all(held.filter((h) => h.path.test(path)).map((h) => h.released));
    }

    if (path === "/config") return route.fulfill(json(200, UI_CONFIG));
    if (path === "/capabilities") return route.fulfill(json(200, CAPABILITIES));
    if (path === "/version") return route.fulfill(json(200, api.version));
    if (path === "/auth/me") return route.fulfill(json(200, ME));
    if (path === "/analytics/metrics") {
      if (api.failMetrics) return route.fulfill(json(api.failMetrics.status, api.failMetrics));
      return route.fulfill(json(200, clusterMetricsFor(api.apps, api.restarts)));
    }

    if (path === "/apps" && method === "GET") {
      if (api.failList) return route.fulfill(json(api.failList.status, api.failList));
      return route.fulfill(json(200, api.apps));
    }
    if ((path === "/apps" || path === "/apps/upload") && method === "POST") {
      // The new App is served from then on, so the UI can open its page.
      const app = created(requestBody(request) as AppCreate);
      api.apps.push(app);
      return route.fulfill(json(201, app));
    }

    const match = path.match(/^\/apps\/([^/]+)\/([^/]+)(?:\/(.+))?$/);
    if (match) {
      const [, namespace, name, sub] = match;
      const app = api.apps.find((a) => a.namespace === namespace && a.name === name);
      if (!app) return route.fulfill(json(404, { detail: `App ${namespace}/${name} not found` }));
      if (!sub && method === "GET") return route.fulfill(json(200, app));
      if (!sub && method === "PATCH") return route.fulfill(json(200, app));
      if (!sub && method === "DELETE") return route.fulfill({ status: 204 });
      if (sub === "logs") return route.fulfill(json(200, { logs: api.logs }));
      if (sub === "events") return route.fulfill(json(200, EVENTS));
      if (sub === "metrics") {
        return route.fulfill(json(200, appMetricsFor(app, api.restarts, api.metricsServer)));
      }
      if (["start", "stop", "restart"].includes(sub ?? "") && method === "POST") {
        return route.fulfill(json(200, app));
      }
    }

    return route.fulfill(json(404, { detail: `No e2e fixture for ${method} ${url.pathname}` }));
  });
}

/** A held path and the promise that resolves when the test releases it. */
interface Held {
  path: RegExp;
  released: Promise<void>;
}

/**
 * Findings that are not defects, each narrowed to one rule and one element.
 *
 * - aria-hidden-focus on Base UI's focus guards: an open popup (the account
 *   menu, from the vendored components/ui/dropdown-menu) brackets itself with
 *   `<span tabindex="0" aria-hidden="true" data-base-ui-focus-guard>` so Tab
 *   leaves it in DOM order. A guard never keeps focus: it hands it straight on
 *   to the next real control. Raise upstream (nebari-design / Base UI) rather
 *   than widen this.
 */
function isKnownFalsePositive(ruleId: string, html: string): boolean {
  return ruleId === "aria-hidden-focus" && html.includes("data-base-ui-focus-guard");
}

/**
 * Fails on critical or serious axe violations under WCAG 2.0/2.1 A and AA.
 * Moderate and minor findings are left to review rather than failing CI.
 */
export async function expectNoCriticalOrSeriousA11yViolations(page: Page) {
  // Disable CSS transitions/animations so axe measures settled colors rather
  // than intermediate values mid-transition (e.g. right after a theme switch),
  // which otherwise produces flaky color-contrast violations. Zeroing the
  // duration is not enough: a transition already in flight keeps running with
  // its original duration and can leave a color at an intermediate value under
  // CI load. Removing the transition property cancels in-flight transitions and
  // snaps computed colors to their final values.
  await page.addStyleTag({
    content: `*, *::before, *::after {
      transition: none !important;
      animation: none !important;
    }`,
  });

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const violations = results.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter((node) => !isKnownFalsePositive(violation.id, node.html)),
    }))
    .filter((violation) => violation.nodes.length > 0)
    .map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      targets: nodes.map((node) => node.target).slice(0, 5),
    }));

  expect(violations).toEqual([]);
}

/** Asserts which theme <html> resolved to (the `dark` class from the theme hook). */
export async function expectResolvedTheme(page: Page, theme: Theme) {
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
}

export const test = base.extend<{
  api: MockApi;
  /** Saved theme preference, applied before the first paint. Override with test.use. */
  theme: Theme;
}>({
  theme: ["light", { option: true }],

  api: [
    async ({ page, theme }, use) => {
      const held: Held[] = [];
      const api: MockApi = {
        apps: structuredClone(DEFAULT_APPS),
        failList: null,
        failMetrics: null,
        logs: LOGS,
        version: { ...API_VERSION },
        restarts: { ...RESTARTS },
        metricsServer: true,
        requests: [],
        hold: (path) => {
          let release = () => {};
          held.push({ path, released: new Promise<void>((resolve) => (release = resolve)) });
          return release;
        },
      };
      // Saved before any script runs, as a returning user's preference would be,
      // so index.html's pre-paint bootstrap picks it up.
      await page.addInitScript(
        ([key, mode]) => {
          try {
            window.localStorage.setItem(key, mode);
          } catch {
            // Storage blocked: the theme falls back to the OS preference.
          }
        },
        [THEME_STORAGE_KEY, theme] as const,
      );
      await installApiRoutes(page, api, held);
      await use(api);
    },
    { auto: true },
  ],
});

export { expect };
