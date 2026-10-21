/*
 * Fixture data for the mocked apps-api: App objects shaped like the API's wire
 * types (src/lib/types.ts, over the generated crd.gen.ts), so a change to those
 * types fails `tsc -b` here as well as in the app.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ApiVersion,
  App,
  AppEvent,
  AppMetrics,
  Capabilities,
  ClusterMetrics,
  Me,
  UiConfig,
} from "../src/lib/types";

export const APPS_DOMAIN = "apps.example.com";
export const NAMESPACES = ["apps", "team-data"];

/**
 * GET /api/v1/config with `api.auth.enabled=false`: keycloak-js is never loaded.
 * Its version and build are the API's, kept distinct so a test notices if the
 * UI shows them as its own.
 */
export const UI_CONFIG: UiConfig = {
  version: "0.0.0-config",
  build: "sha-config",
  authEnabled: false,
  keycloak: { url: "", realm: "", clientId: "" },
  appsDomain: APPS_DOMAIN,
  appsScheme: "https",
};

/**
 * The UI's own release, which vite.config.ts bakes into the bundle from
 * package.json. Read from the working directory (ui/, for both Playwright and
 * Vitest, which also imports this file and resolves import.meta.url to http:).
 */
export const UI_VERSION: string = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version;

/** The UI image tag the chart renders into /config.json as `build`. */
export const UI_BUILD = "sha-e2e";

/**
 * /config.json as the chart renders it with no ui.branding.* set: public/config.json
 * plus the UI's image tag.
 */
export const BRANDING = {
  title: "",
  logoUrl: "",
  logoUrlDark: "",
  faviconUrl: "",
  theme: { light: {}, dark: {} },
  banners: { top: {}, bottom: {} },
  build: UI_BUILD,
};

export const CAPABILITIES: Capabilities = {
  appsDomain: APPS_DOMAIN,
  sourceTypes: ["git", "inline", "pvc", "image"],
  namespaces: NAMESPACES,
  idleTimeoutMinutes: 30,
  imageRegistries: ["ghcr.io/example"],
};

/** GET /api/v1/version: the same release and image as the UI, as after a rollout. */
export const API_VERSION: ApiVersion = { version: UI_VERSION, build: UI_BUILD };

/** GET /api/v1/auth/me with auth disabled: the anonymous caller, an admin. */
export const ME: Me = {
  username: "anonymous",
  email: "",
  groups: ["analytics", "docs-team"],
  admin: true,
};

const condition = (type: string, status: "True" | "False", reason: string, message = "") => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: "2026-10-19T12:00:00Z",
});

export const DOCS_SITE: App = {
  name: "docs-site",
  namespace: "apps",
  displayName: "Docs Site",
  description: "Team documentation",
  thumbnail: "",
  owner: "alice",
  createdAt: "2026-10-19T12:00:00Z",
  source: { type: "git", git: { url: "https://github.com/example/docs", ref: "main" } },
  runtime: { replicas: 1, env: [{ name: "LOG_LEVEL", value: "info" }], secretKeys: ["API_KEY"] },
  access: {
    public: false,
    groups: ["analytics"],
    managers: { users: ["dave"], groups: ["docs-team"] },
    subdomain: "docs-site",
  },
  role: "admin",
  status: {
    phase: "Running",
    url: `https://docs-site.${APPS_DOMAIN}`,
    message: "1/1 replicas ready",
    replicas: { desired: 1, ready: 1 },
    conditions: [
      condition("Validated", "True", "Valid"),
      condition("WorkloadReady", "True", "Available"),
      condition("RoutingReady", "True", "Ready"),
    ],
  },
};

export const SALES_DASHBOARD: App = {
  name: "sales-dashboard",
  namespace: "team-data",
  displayName: "Sales Dashboard",
  description: "",
  thumbnail: "",
  owner: "bob",
  createdAt: "2026-10-18T09:30:00Z",
  source: { type: "inline" },
  runtime: { replicas: 0, pixiTask: "start" },
  access: { public: true, subdomain: "sales" },
  status: {
    phase: "Stopped",
    url: `https://sales.${APPS_DOMAIN}`,
    message: "Scaled to zero",
    replicas: { desired: 0, ready: 0 },
    conditions: [condition("Validated", "True", "Valid")],
  },
};

export const BROKEN_APP: App = {
  name: "broken-app",
  namespace: "apps",
  displayName: "Broken App",
  description: "",
  thumbnail: "",
  owner: "alice",
  createdAt: "2026-10-17T08:00:00Z",
  source: { type: "pvc", pvc: { claimName: "shared-sites" } },
  runtime: { replicas: 1 },
  access: { public: false, subdomain: "broken-app" },
  status: {
    phase: "Failed",
    url: "",
    message: "CrashLoopBackOff",
    replicas: { desired: 1, ready: 0 },
    conditions: [
      condition("Validated", "True", "Valid"),
      condition("WorkloadReady", "False", "CrashLoopBackOff", "Back-off restarting container"),
    ],
  },
};

export const DEFAULT_APPS: App[] = [DOCS_SITE, SALES_DASHBOARD, BROKEN_APP];

export const LOGS = [
  "2026-10-19T12:00:01Z nginx: starting",
  "2026-10-19T12:00:02Z GET /index.html 200",
  "2026-10-19T12:00:03Z GET /missing.png 404",
].join("\n");

export const EVENTS: AppEvent[] = [
  {
    type: "Normal",
    reason: "Scheduled",
    message: "Successfully assigned apps/docs-site-abc to node-1",
    kind: "Pod",
    object: "docs-site-abc",
    count: 1,
    lastTimestamp: "2026-10-19T12:00:00Z",
  },
];

/**
 * Container restarts per App ("namespace/name"): Docs Site is running but has
 * restarted once, Broken App is Failed and crash-looping, so the Apps page's
 * Needs attention banner counts a restarting app and a failed one by default.
 */
export const RESTARTS: Record<string, number> = {
  "apps/docs-site": 1,
  "apps/broken-app": 4,
};

/**
 * GET /apps/{namespace}/{name}/metrics: one pod with a 500m / 512Mi limit, up
 * three days. Broken App's container was last OOMKilled and is crash-looping
 * (not running). `usage` false is a cluster without a metrics server.
 */
export function appMetricsFor(app: App, restarts = RESTARTS, usage = true): AppMetrics {
  const now = Date.now();
  const broken = app.status.phase === "Failed";
  return {
    available: usage,
    pods: [
      {
        name: `${app.name}-abc`,
        cpu: usage ? "12m" : "",
        memory: usage ? "34Mi" : "",
        restarts: restarts[`${app.namespace}/${app.name}`] ?? 0,
        lastTermination: broken
          ? {
              reason: "OOMKilled",
              exitCode: 137,
              finishedAt: new Date(now - 12 * 60_000).toISOString(),
            }
          : null,
        startedAt: broken ? null : new Date(now - 3 * 24 * 3_600_000).toISOString(),
        limits: { cpu: "500m", memory: "512Mi" },
        requests: { cpu: "100m", memory: "128Mi" },
      },
    ],
  };
}

/** GET /analytics/metrics: every App with pods (anything not Stopped). */
export function clusterMetricsFor(apps: App[], restarts = RESTARTS): ClusterMetrics {
  const live = apps.filter((a) => a.status.phase !== "Stopped");
  return {
    usageAvailable: true,
    apps: live.map((a, i) => ({
      namespace: a.namespace,
      name: a.name,
      cpu: 12 + i,
      memory: 34 + i,
      restarts: restarts[`${a.namespace}/${a.name}`] ?? 0,
    })),
    byNamespace: [...new Set(live.map((a) => a.namespace))].map((namespace) => ({
      namespace,
      cpu: 12,
      memory: 34,
    })),
  };
}
