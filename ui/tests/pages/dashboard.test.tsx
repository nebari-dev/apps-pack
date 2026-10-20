import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, AppUsage } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    analytics: vi.fn(),
    clusterMetrics: vi.fn(),
    listApps: vi.fn(),
  },
}));

const { api } = await import("@/lib/api");
const { DashboardPage } = await import("@/pages/dashboard");
const mocked = vi.mocked(api);

function app(name: string, phase = "Running", namespace = "apps"): App {
  return {
    name,
    namespace,
    displayName: name === "docs" ? "Docs Site" : name,
    owner: "alice",
    createdAt: "2026-10-01T12:00:00Z",
    source: { type: "inline" },
    access: { public: true, subdomain: name },
    status: { phase, conditions: [] },
  } as unknown as App;
}

const usage = (name: string, restarts: number, namespace = "apps"): AppUsage => ({
  namespace,
  name,
  cpu: 1,
  memory: 1,
  restarts,
});

function renderDashboard(apps: App[], restarts: AppUsage[]) {
  mocked.analytics.mockResolvedValue({
    total: apps.length,
    byPhase: { Running: apps.length },
    bySourceType: { inline: apps.length },
    byNamespace: { apps: apps.length },
    readyReplicas: 1,
    desiredReplicas: 1,
  });
  mocked.listApps.mockResolvedValue(apps);
  mocked.clusterMetrics.mockResolvedValue({
    usageAvailable: false,
    apps: restarts,
    byNamespace: [],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The Needs attention card's rows, once the card has loaded. */
async function attentionRows() {
  const title = await screen.findByText("Needs attention");
  const card = title.closest("[data-slot=card]") as HTMLElement;
  await within(card).findByRole("list");
  return within(card).getAllByRole("listitem");
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Needs attention card", () => {
  it("lists failed and restarting apps once each, linking to their pages", async () => {
    renderDashboard(
      [app("docs"), app("broken", "Failed"), app("stuck", "Failed", "team"), app("calm")],
      [usage("docs", 1), usage("broken", 4), usage("calm", 0), usage("flaky", 7, "team")],
    );
    const rows = await attentionRows();
    // Failed first (by restarts), then restarting by count; "calm" has none.
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual([
      "broken",
      "stuck",
      "flaky",
      "Docs Site",
    ]);
    expect(rows[0]).toHaveTextContent("Failed · 4 restarts");
    expect(rows[1]).toHaveTextContent(/teamFailed$/);
    expect(rows[2]).toHaveTextContent("7 restarts");
    expect(rows[3]).toHaveTextContent("1 restart");
    expect(within(rows[3]).getByRole("link")).toHaveAttribute("href", "/apps/apps/docs");
    expect(within(rows[2]).getByRole("link")).toHaveAttribute("href", "/apps/team/flaky");
  });

  it("styles failed apps and 3+ restarts as destructive, fewer restarts as secondary", async () => {
    renderDashboard([app("broken", "Failed")], [usage("a", 3), usage("b", 2)]);
    const rows = await attentionRows();
    const badge = (i: number) => rows[i].querySelector("[data-slot=badge]");
    expect(badge(0)).toHaveClass("bg-destructive");
    expect(badge(1)).toHaveClass("bg-destructive");
    expect(badge(2)).toHaveClass("bg-secondary");
  });

  it("says so when nothing needs attention", async () => {
    renderDashboard([app("docs")], [usage("docs", 0)]);
    expect(
      await screen.findByText("Everything is running — no restarts or failed apps."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
