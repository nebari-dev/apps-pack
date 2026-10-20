import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsSummary, App, AppCondition, AppUsage } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    analytics: vi.fn(),
    clusterMetrics: vi.fn(),
    listApps: vi.fn(),
    restartApp: vi.fn(),
  },
}));

const { api } = await import("@/lib/api");
const { DashboardPage } = await import("@/pages/dashboard");
const mocked = vi.mocked(api);

function app(
  name: string,
  phase = "Running",
  namespace = "apps",
  status: Partial<App["status"]> = {},
): App {
  return {
    name,
    namespace,
    displayName: name === "docs" ? "Docs Site" : name,
    owner: "alice",
    createdAt: "2026-10-01T12:00:00Z",
    source: { type: "inline" },
    access: { public: true, subdomain: name },
    status: { phase, conditions: [], message: "", ...status },
  } as unknown as App;
}

const usage = (name: string, restarts: number, namespace = "apps"): AppUsage => ({
  namespace,
  name,
  cpu: 1,
  memory: 1,
  restarts,
});

function renderDashboard(
  apps: App[],
  restarts: AppUsage[],
  summary: Partial<AnalyticsSummary> = {},
) {
  mocked.analytics.mockResolvedValue({
    total: apps.length,
    byPhase: { Running: apps.length },
    bySourceType: { inline: apps.length },
    byNamespace: { apps: apps.length },
    readyReplicas: 1,
    desiredReplicas: 1,
    ...summary,
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

/** The Needs attention table's body rows, once the card has loaded. */
async function attentionRows() {
  const table = await screen.findByRole("table", { name: "Apps that need attention" });
  return within(table).getAllByRole("row").slice(1);
}

const cell = (row: HTMLElement, i: number) => within(row).getAllByRole("cell")[i];

const condition = (
  type: string,
  status: AppCondition["status"],
  reason: string,
  message = "",
): AppCondition => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: "",
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Needs attention card", () => {
  it("renders a row per failed or restarting app, failed first then by restarts", async () => {
    renderDashboard(
      [app("docs"), app("broken", "Failed"), app("stuck", "Failed", "team"), app("calm")],
      [usage("docs", 1), usage("broken", 4), usage("calm", 0), usage("flaky", 7, "team")],
    );
    const rows = await attentionRows();
    // "calm" has neither a failure nor restarts; "flaky" is known from metrics only.
    expect(rows.map((r) => within(cell(r, 0)).getByRole("link").textContent)).toEqual([
      "broken",
      "stuck",
      "flaky",
      "Docs Site",
    ]);
    expect(cell(rows[0], 0)).toHaveTextContent("broken · apps");
    expect(cell(rows[1], 0)).toHaveTextContent("stuck · team");
    expect(within(cell(rows[3], 0)).getByRole("link")).toHaveAttribute("href", "/apps/apps/docs");
    expect(within(cell(rows[2], 0)).getByRole("link")).toHaveAttribute("href", "/apps/team/flaky");

    expect(cell(rows[0], 1)).toHaveTextContent("Failed");
    expect(cell(rows[3], 1)).toHaveTextContent("Running");
    // Restarts, with a dash for none.
    expect(rows.map((r) => cell(r, 2).textContent)).toEqual(["4", "—", "7", "1"]);
  });

  it("tints Failed rows and keys the phase on the row", async () => {
    renderDashboard([app("broken", "Failed"), app("docs")], [usage("docs", 2)]);
    const rows = await attentionRows();
    expect(rows[0]).toHaveAttribute("data-phase", "Failed");
    expect(rows[0]).toHaveClass("data-[phase=Failed]:bg-destructive/40");
    expect(rows[1]).toHaveAttribute("data-phase", "Running");
  });

  it("shows why a Failed app failed: the failing condition, else the status message", async () => {
    renderDashboard(
      [
        app("broken", "Failed", "apps", {
          conditions: [
            condition("Validated", "True", "Valid"),
            condition("WorkloadReady", "False", "CrashLoopBackOff", "Back-off restarting"),
          ],
        }),
        app("odd", "Failed", "apps", { message: "image pull failed" }),
        app("docs"),
      ],
      [usage("docs", 1)],
    );
    const rows = await attentionRows();
    expect(cell(rows[0], 1)).toHaveTextContent("FailedCrashLoopBackOff");
    expect(cell(rows[0], 1)).not.toHaveTextContent("Valid");
    expect(cell(rows[1], 1)).toHaveTextContent("Failedimage pull failed");
    expect(cell(rows[2], 1)).toHaveTextContent(/^Running$/);
  });

  it("links every row to its Logs tab and offers Restart only on Failed rows", async () => {
    const user = userEvent.setup();
    const broken = app("broken", "Failed");
    mocked.restartApp.mockResolvedValue(broken);
    renderDashboard([broken, app("docs")], [usage("docs", 3)]);
    const rows = await attentionRows();

    expect(within(rows[0]).getByRole("link", { name: "Logs for broken" })).toHaveAttribute(
      "href",
      "/apps/apps/broken?tab=logs",
    );
    expect(within(rows[1]).getByRole("link", { name: "Logs for Docs Site" })).toHaveAttribute(
      "href",
      "/apps/apps/docs?tab=logs",
    );
    expect(within(rows[1]).queryByRole("button", { name: /Restart/ })).not.toBeInTheDocument();

    await user.click(within(rows[0]).getByRole("button", { name: "Restart broken" }));
    expect(mocked.restartApp).toHaveBeenCalledWith("apps", "broken");
  });

  it("says so in one line, with no table, when nothing needs attention", async () => {
    renderDashboard([app("docs")], [usage("docs", 0)]);
    expect(
      await screen.findByText("Everything is running — no restarts or failed apps."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("puts a muted warning icon inside the card title when all is clear", async () => {
    renderDashboard([app("docs")], []);
    await screen.findByText("Everything is running — no restarts or failed apps.");
    const icon = screen.getByText("Needs attention").querySelector("svg");
    expect(icon).toHaveClass("text-muted-foreground");
    expect(icon).not.toHaveClass("text-warning-foreground");
  });

  it("colours the warning icon when something needs attention", async () => {
    renderDashboard([app("broken", "Failed")], []);
    await attentionRows();
    const icon = screen.getByText("Needs attention").querySelector("svg");
    expect(icon).toHaveClass("text-warning-foreground");
  });
});

describe("Dashboard layout", () => {
  it("leads with Needs attention, then the counts, the breakdown and recent apps", async () => {
    renderDashboard([app("docs")], []);
    await screen.findByText("Everything is running — no restarts or failed apps.");
    const heading = screen.getByRole("heading", { level: 1, name: "Dashboard" });
    const sections = [
      heading,
      screen.getByText("Needs attention"),
      screen.getByLabelText("App counts"),
      screen.getByText("Breakdown"),
      screen.getByText("Recently launched"),
    ];
    for (let i = 1; i < sections.length; i++) {
      expect(
        sections[i - 1].compareDocumentPosition(sections[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // Needs attention is the first card on the page.
    expect(document.querySelector("[data-slot=card]")).toHaveTextContent(/^Needs attention/);
  });
});

describe("Counts row", () => {
  it("lists each phase present in severity order, then replicas and namespaces", async () => {
    renderDashboard([app("docs")], [], {
      total: 9,
      byPhase: { Running: 4, Stopped: 1, Failed: 2, Pending: 2, Deploying: 0 },
      byNamespace: { apps: 6, team: 3 },
      readyReplicas: 4,
      desiredReplicas: 7,
    });
    const counts = await screen.findByLabelText("App counts");
    const entries = within(counts)
      .getAllByRole("term")
      .map((dt) => `${dt.nextElementSibling?.textContent} ${dt.textContent}`);
    expect(entries).toEqual([
      "2 Failed",
      "2 Pending",
      "4 Running",
      "1 Stopped",
      "4/7 replicas ready",
      "2 namespaces",
    ]);
    expect(screen.queryByText(/not running/i)).not.toBeInTheDocument();
  });

  it("keeps phases it does not know, after the known ones", async () => {
    renderDashboard([app("docs")], [], { byPhase: { Unknown: 1, Running: 1 } });
    const counts = await screen.findByLabelText("App counts");
    expect(
      within(counts)
        .getAllByRole("term")
        .map((t) => t.textContent),
    ).toEqual(["Running", "Unknown", "replicas ready", "namespaces"]);
  });
});

describe("Breakdown card", () => {
  it("switches between status, source and namespace, labelling inline as Upload", async () => {
    const user = userEvent.setup();
    renderDashboard([app("docs")], [], {
      total: 3,
      byPhase: { Running: 2, Failed: 1 },
      bySourceType: { inline: 1, git: 1, pvc: 1 },
      byNamespace: { apps: 2, team: 1 },
    });
    const tabs = await screen.findByRole("tablist", { name: "Break down apps by" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Status", "Source", "Namespace"]);
    expect(within(tabs).getByRole("tab", { name: "Status" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = () => screen.getByRole("tabpanel");
    expect(within(panel()).getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText("By status")).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole("tab", { name: "Source" }));
    expect(within(panel()).getByText("Upload")).toBeInTheDocument();
    expect(within(panel()).getByText("Git")).toBeInTheDocument();
    expect(within(panel()).getByText("PVC")).toBeInTheDocument();
    expect(within(panel()).queryByText("inline")).not.toBeInTheDocument();

    await user.click(within(tabs).getByRole("tab", { name: "Namespace" }));
    expect(within(panel()).getByText("team")).toBeInTheDocument();
  });
});

describe("Recently launched card", () => {
  it("shows the three newest apps with one status badge each and links to all apps", async () => {
    const apps = ["a", "b", "c", "d", "e"].map((name, i) => ({
      ...app(name, i === 4 ? "Stopped" : "Running"),
      createdAt: `2026-10-0${i + 1}T00:00:00Z`,
      source: { type: "git" },
    })) as App[];
    renderDashboard(apps, []);
    const list = await screen.findByRole("list", { name: "Recently launched apps" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => within(li).getByRole("link").textContent)).toEqual(["e", "d", "c"]);
    expect(items[0]).toHaveTextContent(/^Eeapps · aliceStopped$/);
    expect(items[1]).toHaveTextContent(/^Ddapps · aliceRunning$/);
    expect(screen.getByRole("link", { name: "All apps" })).toHaveAttribute("href", "/apps");
  });
});

describe("empty and error states", () => {
  it("shows onboarding, not the dashboard cards, on an empty cluster", async () => {
    renderDashboard([], [], { total: 0, byPhase: {}, bySourceType: {}, byNamespace: {} });
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText("Breakdown")).not.toBeInTheDocument();
  });
});
