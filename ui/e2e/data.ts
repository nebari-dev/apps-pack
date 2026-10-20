/*
 * Fixture data for the mocked apps-api: App objects shaped like the API's wire
 * types (src/lib/types.ts, over the generated crd.gen.ts), so a change to those
 * types fails `tsc -b` here as well as in the app.
 */
import type {
  AnalyticsSummary,
  App,
  AppEvent,
  Capabilities,
  ClusterMetrics,
  UiConfig,
} from "../src/lib/types";

export const APPS_DOMAIN = "apps.example.com";
export const NAMESPACES = ["apps", "team-data"];

/** GET /api/v1/config with `api.auth.enabled=false`: keycloak-js is never loaded. */
export const UI_CONFIG: UiConfig = {
  version: "0.0.0-e2e",
  build: "sha-e2e",
  authEnabled: false,
  keycloak: { url: "", realm: "", clientId: "" },
  appsDomain: APPS_DOMAIN,
  appsScheme: "https",
};

/** /config.json as the chart renders it with no ui.branding.* set (public/config.json). */
export const BRANDING = {
  title: "",
  logoUrl: "",
  logoUrlDark: "",
  faviconUrl: "",
  theme: { light: {}, dark: {} },
  banners: { top: {}, bottom: {} },
};

export const CAPABILITIES: Capabilities = {
  appsDomain: APPS_DOMAIN,
  sourceTypes: ["git", "inline", "pvc"],
  namespaces: NAMESPACES,
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
  runtime: { replicas: 1, env: [{ name: "LOG_LEVEL", value: "info" }] },
  access: { public: false, groups: ["analytics"], users: ["grace"], subdomain: "docs-site" },
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

/** GET /analytics/summary, computed from the apps the mock is serving. */
export function analyticsFor(apps: App[]): AnalyticsSummary {
  const count = (key: (a: App) => string) =>
    apps.reduce<Record<string, number>>((acc, a) => {
      acc[key(a)] = (acc[key(a)] ?? 0) + 1;
      return acc;
    }, {});
  return {
    total: apps.length,
    byPhase: count((a) => a.status.phase),
    bySourceType: count((a) => a.source?.type ?? "unknown"),
    byNamespace: count((a) => a.namespace),
    readyReplicas: apps.reduce((n, a) => n + (a.status.replicas?.ready ?? 0), 0),
    desiredReplicas: apps.reduce((n, a) => n + (a.status.replicas?.desired ?? 0), 0),
  };
}

/**
 * Container restarts per App ("namespace/name"): Docs Site is running but has
 * restarted once, Broken App is Failed and crash-looping, so the dashboard's
 * Needs attention card has a restarting row and a failed one by default.
 */
export const RESTARTS: Record<string, number> = {
  "apps/docs-site": 1,
  "apps/broken-app": 4,
};

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
