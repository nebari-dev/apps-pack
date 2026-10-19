import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Layout } from "@/components/layout";
import { ThemeProvider } from "@/hooks/theme-provider";
import type { App } from "@/lib/types";

const APP: App = {
  name: "docs-site",
  namespace: "apps",
  displayName: "Docs Site",
  description: "Team docs",
  thumbnail: "",
  owner: "alice",
  createdAt: "2026-10-19T12:00:00Z",
  source: { type: "inline", inline: { files: { "index.html": "<h1>hi</h1>" } } },
  runtime: { replicas: 1, env: [{ name: "LOG_LEVEL", value: "info" }] },
  access: { public: false, groups: ["analytics"], subdomain: "docs-site" },
  status: {
    phase: "Running",
    url: "https://docs-site.apps.example.ai",
    replicas: { desired: 1, ready: 1 },
    conditions: [
      { type: "Validated", status: "True", reason: "Valid", message: "", lastTransitionTime: "" },
      {
        type: "RoutingReady",
        status: "False",
        reason: "Pending",
        message: "",
        lastTransitionTime: "",
      },
    ],
    message: "",
  },
} as unknown as App;

vi.mock("@/lib/api", () => ({
  api: {
    capabilities: vi.fn(async () => ({
      appsDomain: "apps.example.ai",
      sourceTypes: ["git", "inline", "pvc"],
      namespaces: ["apps"],
    })),
    analytics: vi.fn(async () => ({
      total: 1,
      byPhase: { Running: 1 },
      bySourceType: { inline: 1 },
      byNamespace: { apps: 1 },
      readyReplicas: 1,
      desiredReplicas: 1,
    })),
    clusterMetrics: vi.fn(async () => ({
      usageAvailable: true,
      apps: [{ namespace: "apps", name: "docs-site", cpu: 12, memory: 34, restarts: 0 }],
      byNamespace: [{ namespace: "apps", cpu: 12, memory: 34 }],
    })),
    listApps: vi.fn(async () => [APP]),
    getApp: vi.fn(async () => APP),
    metrics: vi.fn(async () => ({ available: true, pods: [] })),
    logs: vi.fn(async () => ({ logs: "hello" })),
    events: vi.fn(async () => []),
  },
}));

const { AppDetailPage } = await import("@/pages/app-detail");
const { AppsPage } = await import("@/pages/apps");
const { DashboardPage } = await import("@/pages/dashboard");
const { EditPage } = await import("@/pages/edit");
const { LaunchPage } = await import("@/pages/launch");
const { MetricsPage } = await import("@/pages/metrics");

const PAGES: [string, string, string, ReactElement, string][] = [
  ["dashboard", "/", "", <DashboardPage key="d" />, "Dashboard"],
  ["apps", "/apps", "apps", <AppsPage key="a" />, "Apps"],
  [
    "app detail",
    "/apps/apps/docs-site",
    "apps/:namespace/:name",
    <AppDetailPage key="ad" />,
    "Docs Site",
  ],
  [
    "edit",
    "/apps/apps/docs-site/edit",
    "apps/:namespace/:name/edit",
    <EditPage key="e" />,
    "Edit app",
  ],
  ["launch", "/launch", "launch", <LaunchPage key="l" />, "Launch an app"],
  ["metrics", "/metrics", "metrics", <MetricsPage key="m" />, "Metrics"],
];

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

async function violations(): Promise<string[]> {
  const result = await axe.run(document.body, {
    // jsdom does no layout or painting, so contrast cannot be computed here.
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
  );
}

describe.each(["light", "dark"])("%s theme", (theme) => {
  it.each(PAGES)("%s page has no axe violations", async (_name, url, path, page, heading) => {
    if (theme === "dark") document.documentElement.classList.add("dark");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider storageKey="a11y-test">
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route element={<Layout />}>
                <Route path={path || undefined} index={!path} element={page} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: heading });
    expect(await violations()).toEqual([]);
    expect(document.title).toContain(heading === "Docs Site" ? "docs-site" : heading);
  });
});

it("has a skip link to the main content", async () => {
  render(
    <ThemeProvider storageKey="a11y-test">
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<p>home</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
  expect(screen.getByRole("main")).toHaveAttribute("id", "main");
});

function renderAt(url: string, routes: ReactElement) {
  return render(
    <ThemeProvider storageKey="a11y-test">
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route element={<Layout />}>{routes}</Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

it("ties a validation error to its field", async () => {
  renderAt("/launch", <Route path="launch" element={<LaunchPage />} />);
  const name = await screen.findByLabelText("Name");
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(name).toHaveAttribute("aria-describedby", "form-error");
  expect(screen.getByRole("alert")).toHaveTextContent("Give the app a name.");
  expect(screen.getByLabelText("Display name")).not.toHaveAttribute("aria-invalid");
});

it("moves focus to the new page's heading after navigating", async () => {
  const user = (await import("@testing-library/user-event")).default.setup();
  renderAt(
    "/apps",
    <>
      <Route path="apps" element={<AppsPage />} />
      <Route path="metrics" element={<MetricsPage />} />
    </>,
  );
  await screen.findByRole("heading", { level: 1, name: "Apps" });
  await user.click(screen.getByRole("link", { name: /metrics/i }));
  const heading = await screen.findByRole("heading", { level: 1, name: "Metrics" });
  expect(heading).toHaveFocus();
});
