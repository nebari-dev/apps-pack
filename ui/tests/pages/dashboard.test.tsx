import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { App, AppCondition, AppUsage } from "@/lib/types";

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

  it("puts the warning icon inside the card title", async () => {
    renderDashboard([app("docs")], []);
    const title = await screen.findByText("Needs attention");
    expect(title.querySelector("svg")).not.toBeNull();
  });
});
