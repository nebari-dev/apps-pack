import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toast";
import type { App } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    listApps: vi.fn(),
    clusterMetrics: vi.fn(),
    getApp: vi.fn(),
    logs: vi.fn(),
    events: vi.fn(),
    metrics: vi.fn(),
    startApp: vi.fn(),
    stopApp: vi.fn(),
    restartApp: vi.fn(),
    deleteApp: vi.fn(),
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getUser: vi.fn(),
}));

const { api } = await import("@/lib/api");
const { getUser } = await import("@/lib/auth");
const { AppsPage } = await import("@/pages/apps");
const { AppDetailPage } = await import("@/pages/app-detail");
const mocked = vi.mocked(api);

function app(name: string, over: Partial<App> & { phase?: string } = {}): App {
  const { phase = "Running", ...rest } = over;
  return {
    name,
    namespace: "apps",
    displayName: name,
    description: "",
    thumbnail: "",
    owner: "alice",
    createdAt: "2026-10-01T12:00:00Z",
    source: { type: "inline", inline: { files: { "index.html": "hi" } } },
    runtime: { replicas: 1 },
    access: { public: true, groups: [], subdomain: name },
    status: {
      phase,
      url: `https://${name}.apps.example.ai`,
      replicas: {
        desired: phase === "Stopped" || phase === "Idle" ? 0 : 1,
        ready: phase === "Running" ? 1 : 0,
      },
      conditions: [],
      message: "",
    },
    ...rest,
  } as App;
}

function renderAt(path: string, routes: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {routes}
          <Route path="/" element={<p>apps list</p>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

const NO_RESTARTS = { usageAvailable: true, apps: [], byNamespace: [] };

beforeEach(() => {
  vi.resetAllMocks();
  mocked.clusterMetrics.mockResolvedValue(NO_RESTARTS);
  vi.mocked(getUser).mockReturnValue(null);
});

describe("apps page", () => {
  const LIST = [
    app("beta", { phase: "Stopped", owner: "bob" }),
    app("alpha", { displayName: "Alpha Docs" }),
    app("gamma", {
      phase: "Failed",
      source: { type: "git", git: { url: "https://x", ref: "main" } },
    }),
  ];
  const names = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("link")[0].textContent);

  const renderApps = async (list: App[] = LIST) => {
    mocked.listApps.mockResolvedValue(list);
    renderAt(
      "/",
      <>
        <Route path="/" element={<AppsPage />} />
        <Route path="/apps/:namespace/:name" element={<LocationProbe />} />
      </>,
    );
    await screen.findByRole("link", { name: list[1].displayName });
  };
  const rowOf = (name: string) => screen.getByRole("link", { name }).closest("tr") as HTMLElement;

  it("sorts by severity by default, then by name, and by a column on click", async () => {
    const user = userEvent.setup();
    await renderApps();
    const status = screen.getByRole("button", { name: /Status/ });
    expect(status.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["gamma", "Alpha Docs", "beta"]);

    await user.click(screen.getByRole("button", { name: /^App/ }));
    expect(names()).toEqual(["Alpha Docs", "beta", "gamma"]);

    await user.click(status);
    expect(status.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["gamma", "Alpha Docs", "beta"]);
    await user.click(status);
    expect(status.closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(names()).toEqual(["beta", "Alpha Docs", "gamma"]);
  });

  it("breaks severity ties by display name", async () => {
    await renderApps([
      app("zed"),
      app("mid", { displayName: "Alpha" }),
      app("bad", { phase: "Failed" }),
      app("new", { phase: "Pending" }),
    ]);
    expect(names()).toEqual(["bad", "new", "Alpha", "zed"]);
  });

  it("opens the app when a row is clicked outside its controls", async () => {
    const user = userEvent.setup();
    await renderApps();
    const alpha = rowOf("Alpha Docs");
    expect(alpha).toHaveClass("cursor-pointer");
    expect(alpha).not.toHaveAttribute("tabindex");

    await user.click(within(alpha).getByRole("checkbox"));
    expect(screen.queryByLabelText("location")).not.toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await user.click(within(alpha).getByText("alice"));
    expect(screen.getByLabelText("location")).toHaveTextContent("/apps/apps/alpha");
  });

  it("shows the reason and a Logs shortcut on Failed rows, and no View icon", async () => {
    const failing = app("gamma", { phase: "Failed" });
    failing.status.conditions = [
      { type: "Validated", status: "True", reason: "Valid", message: "" },
      { type: "WorkloadReady", status: "False", reason: "CrashLoopBackOff", message: "x" },
    ] as App["status"]["conditions"];
    await renderApps([app("alpha", { displayName: "Alpha Docs" }), failing]);

    const gamma = rowOf("gamma");
    expect(gamma).toHaveAttribute("data-phase", "Failed");
    expect(within(gamma).getByText("CrashLoopBackOff")).toHaveClass("text-xs");
    expect(within(gamma).getByRole("link", { name: "Logs" })).toHaveAttribute(
      "href",
      "/apps/apps/gamma?tab=logs",
    );
    const alpha = rowOf("Alpha Docs");
    expect(within(alpha).queryByRole("link", { name: "Logs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View" })).not.toBeInTheDocument();
  });

  it("labels Type and Source apart and puts the namespace under the name", async () => {
    await renderApps();
    expect(screen.queryByRole("columnheader", { name: /Namespace/ })).not.toBeInTheDocument();
    const alpha = rowOf("Alpha Docs");
    expect(within(alpha).getByText("alpha · apps")).toBeInTheDocument();
    expect(within(alpha).getByText("Static")).toHaveAttribute("data-variant", "secondary");
    expect(within(alpha).getByText("Upload")).toHaveClass("font-mono");
    expect(within(rowOf("gamma")).getByText("Git")).toBeInTheDocument();
  });

  it("keeps Delete neutral and disables Stop while Pending", async () => {
    await renderApps([app("alpha"), app("queued", { phase: "Pending" })]);
    const del = within(rowOf("alpha")).getByRole("button", { name: "Delete app" });
    expect(del).toHaveClass("text-muted-foreground", "hover:text-destructive-foreground");
    expect(within(rowOf("queued")).getByRole("button", { name: "Stop app" })).toBeDisabled();
    expect(within(rowOf("alpha")).getByRole("button", { name: "Stop app" })).toBeEnabled();
  });

  it("offers bulk Start and Stop only for apps they apply to", async () => {
    const user = userEvent.setup();
    await renderApps([...LIST, app("queued", { phase: "Pending" })]);
    const bulk = () => screen.getByText(/selected$/).parentElement as HTMLElement;

    await user.click(within(rowOf("beta")).getByRole("checkbox"));
    expect(within(bulk()).getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(within(bulk()).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

    await user.click(within(rowOf("beta")).getByRole("checkbox"));
    await user.click(within(rowOf("queued")).getByRole("checkbox"));
    expect(within(bulk()).queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(within(bulk()).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(within(bulk()).getByRole("button", { name: "Delete" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    mocked.stopApp.mockResolvedValue(LIST[1]);
    await user.click(within(bulk()).getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Stopped 2 app(s)")).toBeInTheDocument();
    expect(mocked.stopApp.mock.calls.map(([, name]) => name).sort()).toEqual(["alpha", "gamma"]);
  });

  it("starts only the stopped apps in a bulk selection", async () => {
    const user = userEvent.setup();
    await renderApps();
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    mocked.startApp.mockResolvedValue(LIST[0]);
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText("Started 1 app(s)")).toBeInTheDocument();
    expect(mocked.startApp).toHaveBeenCalledExactlyOnceWith("apps", "beta");
  });

  it("shows chip counts at full contrast", async () => {
    const user = userEvent.setup();
    await renderApps();
    const all = screen.getByRole("button", { name: /All/ });
    const failed = screen.getByRole("button", { name: /Failed/ });
    expect(within(all).getByText("3")).not.toHaveClass("text-muted-foreground");
    expect(within(all).getByText("3")).not.toHaveClass("opacity-70");
    expect(within(failed).getByText("1")).toHaveClass("text-muted-foreground");
    expect(within(failed).getByText("1")).not.toHaveClass("opacity-70");

    await user.click(failed);
    expect(within(failed).getByText("1")).not.toHaveClass("text-muted-foreground");
  });

  it("focuses the search with / unless typing in a field", async () => {
    const user = userEvent.setup();
    await renderApps();
    const search = screen.getByPlaceholderText(/Search by name/);
    expect(search).toHaveAttribute("aria-keyshortcuts", "/");
    expect(screen.getByText("/", { selector: "kbd" })).toBeInTheDocument();

    await user.keyboard("/");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");

    await user.keyboard("a/b");
    expect(search).toHaveValue("a/b");
    expect(screen.queryByText("/", { selector: "kbd" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("clears the search and the phase from the empty filtered state", async () => {
    const user = userEvent.setup();
    await renderApps();
    await user.click(screen.getByRole("button", { name: /Failed/ }));
    await user.type(screen.getByPlaceholderText(/Search by name/), "nothing-matches");
    expect(screen.getByText("No apps match your filter.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(names()).toHaveLength(3);
    expect(screen.getByPlaceholderText(/Search by name/)).toHaveValue("");
    expect(screen.getByRole("button", { name: /All/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("filters by search text and by phase", async () => {
    const user = userEvent.setup();
    await renderApps();
    await user.type(screen.getByPlaceholderText(/Search by name/), "bob");
    expect(names()).toEqual(["beta"]);
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(names()).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: /Failed/ }));
    expect(names()).toEqual(["gamma"]);
    await user.click(screen.getByRole("button", { name: /All/ }));
    expect(names()).toHaveLength(3);
  });

  it("stops and starts from the row and reports the result", async () => {
    const user = userEvent.setup();
    await renderApps();
    mocked.stopApp.mockResolvedValue(LIST[1]);
    mocked.startApp.mockRejectedValue(new Error("quota exceeded"));

    const alpha = screen.getByRole("link", { name: "Alpha Docs" }).closest("tr") as HTMLElement;
    await user.click(within(alpha).getByRole("button", { name: "Stop app" }));
    expect(mocked.stopApp).toHaveBeenCalledWith("apps", "alpha");
    expect(await screen.findByText("Stopped Alpha Docs")).toBeInTheDocument();

    const beta = screen.getByRole("link", { name: "beta" }).closest("tr") as HTMLElement;
    await user.click(within(beta).getByRole("button", { name: "Start app" }));
    // One toast, announced to screen readers with the API's reason.
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to start betaquota exceeded"),
    );
    expect(mocked.startApp).toHaveBeenCalledTimes(1);
  });

  it("hides the Mine chip when auth is off", async () => {
    await renderApps();
    expect(screen.queryByRole("button", { name: /^Mine/ })).not.toBeInTheDocument();
    expect(names()).toHaveLength(3);
  });

  it("defaults Mine on for a user who owns an app, composing with the other filters", async () => {
    const user = userEvent.setup();
    vi.mocked(getUser).mockReturnValue({ name: "bob", email: "bob@example.test" });
    // renderApps waits for the second app, so make it one of bob's.
    const [beta, ...rest] = LIST;
    await renderApps([beta, app("delta", { phase: "Stopped", owner: "bob" }), ...rest]);
    const mine = screen.getByRole("button", { name: /^Mine/ });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(within(mine).getByText("2")).toBeInTheDocument();
    expect(names()).toEqual(["beta", "delta"]);
    // The status chips count within Mine.
    expect(within(screen.getByRole("button", { name: /^All/ })).getByText("2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Failed/ })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/Search by name/), "delta");
    expect(names()).toEqual(["delta"]);
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    await user.click(mine);
    expect(mine).toHaveAttribute("aria-pressed", "false");
    expect(names()).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: /^Failed/ }));
    expect(names()).toEqual(["gamma"]);
    await user.click(mine);
    expect(screen.getByText("No apps match your filter.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(mine).toHaveAttribute("aria-pressed", "false");
    expect(names()).toHaveLength(4);
  });

  it("counts apps the user manages in Mine", async () => {
    vi.mocked(getUser).mockReturnValue({ name: "carol", email: "" });
    // renderApps waits for the second app, so make it the managed one.
    const [first, second, ...rest] = LIST;
    await renderApps([first, { ...second, role: "manager" }, ...rest]);
    const mine = screen.getByRole("button", { name: /^Mine/ });
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(within(mine).getByText("1")).toBeInTheDocument();
    expect(names()).toEqual([second.displayName]);
  });

  it("shows Mine off for a user who owns no app", async () => {
    vi.mocked(getUser).mockReturnValue({ name: "carol", email: "" });
    await renderApps();
    const mine = screen.getByRole("button", { name: /^Mine/ });
    expect(mine).toHaveAttribute("aria-pressed", "false");
    expect(within(mine).getByText("0")).toBeInTheDocument();
    expect(names()).toHaveLength(3);
  });

  it("flags failed and restarting apps and filters to them", async () => {
    const user = userEvent.setup();
    mocked.clusterMetrics.mockResolvedValue({
      ...NO_RESTARTS,
      apps: [{ namespace: "apps", name: "alpha", cpu: 1, memory: 1, restarts: 3 }],
    });
    await renderApps();
    const banner = await screen.findByText("2 apps need attention");
    const alert = banner.closest("[data-slot=alert]") as HTMLElement;
    expect(alert).toHaveAttribute("role", "status");
    expect(alert).toHaveTextContent("1 failed, 1 restarting");
    expect(within(rowOf("Alpha Docs")).getByText("3 restarts")).toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Show" }));
    expect(names()).toEqual(["gamma", "Alpha Docs"]);
    expect(screen.getByRole("button", { name: /^Needs attention/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /^All/ }));
    expect(names()).toHaveLength(3);
  });

  it("shows no attention banner when nothing failed or restarted", async () => {
    await renderApps([app("alpha", { displayName: "Alpha Docs" }), app("beta")]);
    await waitFor(() => expect(mocked.clusterMetrics).toHaveBeenCalled());
    expect(screen.queryByText(/need attention/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Needs attention/ })).not.toBeInTheDocument();
  });

  it("opens only a running app's URL, in a new tab", async () => {
    await renderApps([
      app("alpha", { displayName: "Alpha Docs" }),
      app("beta", { phase: "Stopped" }),
      app("queued", { phase: "Deploying" }),
    ]);
    const open = within(rowOf("Alpha Docs")).getByRole("link", { name: "Open Alpha Docs" });
    expect(open).toHaveAttribute("href", "https://alpha.apps.example.ai");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(rowOf("beta")).queryByRole("link", { name: /^Open/ })).not.toBeInTheDocument();
    expect(within(rowOf("queued")).queryByRole("link", { name: /^Open/ })).not.toBeInTheDocument();
  });

  it("lists an idle app with its URL (a visit wakes it) and Stop, not Start", async () => {
    await renderApps([
      app("alpha", { displayName: "Alpha Docs" }),
      app("sleepy", { phase: "Idle" }),
    ]);
    const row = rowOf("sleepy");
    expect(within(row).getByText("Idle")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open sleepy" })).toHaveAttribute(
      "href",
      "https://sleepy.apps.example.ai",
    );
    expect(within(row).getByRole("button", { name: "Stop app" })).toBeEnabled();
    expect(within(row).queryByRole("button", { name: "Start app" })).not.toBeInTheDocument();
  });

  it("renders the page chrome at once and only skeletons the rows while the list loads", async () => {
    let resolve: (list: App[]) => void = () => {};
    mocked.listApps.mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = renderAt("/", <Route path="/" element={<AppsPage />} />);
    // Static chrome is real from the start: heading, Launch, search, chips, headers.
    expect(screen.getByRole("heading", { level: 1, name: "Apps" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Launch app" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search by name/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    for (const name of ["App", "Status"]) {
      expect(screen.getByRole("columnheader", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByRole("checkbox", { name: "Select all" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // The All chip does not claim "All 0" before the list answers.
    expect(screen.getByRole("button", { name: "All" })).toHaveTextContent(/^All$/);
    expect(screen.getByRole("status")).toHaveTextContent("Loading apps");
    // Only the body rows are placeholders, hidden from assistive tech.
    const body = container.querySelector("tbody");
    expect(body).toHaveAttribute("aria-hidden", "true");
    expect(body?.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.getAllByRole("row")).toHaveLength(1);

    resolve(LIST);
    expect(await screen.findByRole("link", { name: "Alpha Docs" })).toBeInTheDocument();
    expect(screen.queryByText("Loading apps")).toBeNull();
    expect(screen.getByRole("table")).not.toHaveAttribute("aria-busy");
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(screen.getByRole("button", { name: /^All/ })).toHaveTextContent(/^All\s*\d+$/);
    // The rows that replaced the placeholder fade in, gated on motion-safe.
    expect(container.querySelector("tbody")?.className).toContain("motion-safe:animate-fade-in");
  });

  it("shows onboarding, without the filters, when there are no apps", async () => {
    mocked.listApps.mockResolvedValue([]);
    renderAt("/", <Route path="/" element={<AppsPage />} />);
    expect(await screen.findByRole("heading", { name: "No apps yet" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Search by name/)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("selects every visible row", async () => {
    const user = userEvent.setup();
    await renderApps();
    await user.click(screen.getByRole("button", { name: /Failed/ }));
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});

/** Renders the current location so tests can assert on the URL. */
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{`${pathname}${search}`}</output>;
}

describe("app detail page", () => {
  /** Renders the detail page for `a`; `before` overrides the default API mocks. */
  const renderDetail = async (a: App, path = "/apps/apps/docs", before?: () => void) => {
    mocked.getApp.mockResolvedValue(a);
    mocked.logs.mockResolvedValue({ logs: "GET / 200\nGET /missing 404\n" });
    mocked.events.mockResolvedValue([]);
    mocked.metrics.mockResolvedValue({
      available: true,
      pods: [{ name: "p", cpu: "3m", memory: "10Mi" }],
    });
    before?.();
    renderAt(
      path,
      <Route
        path="/apps/:namespace/:name"
        element={
          <>
            <AppDetailPage />
            <LocationProbe />
          </>
        }
      />,
    );
    await screen.findByRole("heading", { level: 1 });
  };

  const condition = (type: string, status: "True" | "False", reason: string, message = "") => ({
    type,
    status,
    reason,
    message,
    lastTransitionTime: "2026-10-19T12:00:00Z",
  });

  /** A crash-looping app, shaped like BROKEN_APP in e2e/data.ts. */
  const failed = (over: Partial<App["status"]> = {}): App => {
    const a = app("docs", { phase: "Failed" });
    return {
      ...a,
      status: {
        ...a.status,
        message: "CrashLoopBackOff",
        conditions: [
          condition("Validated", "True", "Valid"),
          condition("WorkloadReady", "False", "CrashLoopBackOff", "Back-off restarting container"),
        ],
        ...over,
      },
    };
  };

  const openMoreMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "More actions" }));
    return screen.findAllByRole("menuitem");
  };

  it("opens the tab named by ?tab= and writes the chosen tab back to the URL", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"), "/apps/apps/docs?tab=logs");
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/GET \/missing 404/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("location")).toHaveTextContent("/apps/apps/docs?tab=events");
  });

  it("labels the conditions tab Health and falls back to it for an unknown ?tab=", async () => {
    await renderDetail(app("docs"), "/apps/apps/docs?tab=nope");
    expect(screen.getByRole("tab", { name: "Health" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Conditions" })).not.toBeInTheDocument();
  });

  it("offers Open only while Running, and Start for a stopped app", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs", { phase: "Stopped" }));
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument();

    await openMoreMenu(user);
    const restart = screen.getByRole("menuitem", { name: /Restart/ });
    expect(restart).toHaveAttribute("aria-disabled", "true");
    expect(restart).toHaveTextContent("Start the app to restart it");
  });

  it("explains an idle app and wakes it", async () => {
    const user = userEvent.setup();
    const idle = app("docs", { phase: "Idle" });
    idle.status.message = "scaled to zero after 30 minutes without requests";
    idle.status.lastActivityTime = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await renderDetail(idle);
    expect(screen.getByText(/Scaled to zero after going/)).toHaveTextContent(
      "Last request 2 h ago.",
    );
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", idle.status.url);
    mocked.startApp.mockResolvedValue(app("docs", { phase: "Deploying" }));
    await user.click(screen.getByRole("button", { name: /Wake/ }));
    expect(mocked.startApp).toHaveBeenCalledWith("apps", "docs");
    await openMoreMenu(user);
    expect(screen.getByRole("menuitem", { name: /Restart/ })).toHaveTextContent(
      "Wake the app to restart it",
    );
  });

  it("hides Open while an app is still deploying, without alerting", async () => {
    await renderDetail(app("docs", { phase: "Deploying" }));
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says who can manage the app and the caller's role", async () => {
    await renderDetail(
      app("docs", {
        role: "manager",
        access: {
          public: true,
          subdomain: "docs",
          managers: { users: ["dave"], groups: ["web-team"] },
        },
      }),
    );
    expect(screen.getByTestId("managers")).toHaveTextContent(
      "Managed by alice (owner) · users: dave · groups: web-team · admins · You manage this app.",
    );
  });

  it("keeps Restart, Copy URL and Delete in the More menu, Delete last", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"));
    expect(screen.queryByRole("button", { name: /Restart|Delete/ })).not.toBeInTheDocument();
    const items = await openMoreMenu(user);
    expect(items.map((i) => i.textContent)).toEqual(["Restart", "Copy URL", "Delete"]);
    expect(items[2]).toHaveClass("text-destructive-foreground");
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("copies the URL from the More menu and reports the result", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderDetail(app("docs"));

    await openMoreMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Copy URL" }));
    expect(writeText).toHaveBeenCalledWith("https://docs.apps.example.ai");
    expect((await screen.findAllByText("Copied the URL")).length).toBeGreaterThan(0);

    writeText.mockRejectedValueOnce(new Error("denied"));
    await openMoreMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText("Could not copy to clipboard")).length).toBeGreaterThan(0);
  });

  it("disables Copy URL for an app without a URL", async () => {
    const user = userEvent.setup();
    const a = app("docs", { phase: "Pending" });
    await renderDetail({ ...a, status: { ...a.status, url: "" } });
    await openMoreMenu(user);
    expect(screen.getByRole("menuitem", { name: "Copy URL" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("stops and restarts a running app", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"));
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute(
      "href",
      "https://docs.apps.example.ai",
    );
    mocked.stopApp.mockResolvedValue(app("docs"));
    await user.click(screen.getByRole("button", { name: /Stop/ }));
    expect(mocked.stopApp).toHaveBeenCalledWith("apps", "docs");

    mocked.restartApp.mockResolvedValue(app("docs"));
    await openMoreMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Restart" }));
    expect(mocked.restartApp).toHaveBeenCalledWith("apps", "docs");
    expect(await screen.findByText("Restarting docs")).toBeInTheDocument();
  });

  it("deletes only after the name is typed, then returns to the list", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"));
    mocked.deleteApp.mockResolvedValue(undefined);
    await openMoreMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete app" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "doc");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "s");
    await user.click(confirm);
    expect(mocked.deleteApp).toHaveBeenCalledWith("apps", "docs");
    expect(await screen.findByText("apps list")).toBeInTheDocument();
  });

  it("names a failed app's failing condition in an alert, with View logs and Restart", async () => {
    const user = userEvent.setup();
    await renderDetail(failed());
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("WorkloadReady failed: CrashLoopBackOff");
    expect(alert).toHaveTextContent("Back-off restarting container");

    await user.click(within(alert).getByRole("button", { name: "View logs" }));
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("location")).toHaveTextContent("/apps/apps/docs?tab=logs");

    mocked.restartApp.mockResolvedValue(failed());
    await user.click(within(alert).getByRole("button", { name: "Restart" }));
    expect(mocked.restartApp).toHaveBeenCalledWith("apps", "docs");
  });

  it("falls back to the status message for a failed app with no failing condition", async () => {
    await renderDetail(failed({ conditions: [] }));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("App failed");
    expect(alert).toHaveTextContent("CrashLoopBackOff");
  });

  it("alerts on a False condition while Running, describing it with the status message", async () => {
    const a = app("docs");
    await renderDetail({
      ...a,
      status: {
        ...a.status,
        message: "Route is not ready",
        conditions: [condition("RoutingReady", "False", "")],
      },
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("RoutingReady failed: Unknown");
    expect(alert).toHaveTextContent("Route is not ready");
  });

  it("shows CPU and memory and no alert for a healthy app", async () => {
    await renderDetail(app("docs"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("of 1 ready")).toBeInTheDocument();
  });

  it.each([
    ["Stopped", () => app("docs", { phase: "Stopped" })],
    ["Failed", () => failed()],
  ])("explains the missing CPU and memory cards for a %s app", async (_phase, make) => {
    await renderDetail(make());
    expect(
      screen.getByText("CPU and memory are shown once the app is running."),
    ).toBeInTheDocument();
    expect(screen.queryByText("CPU")).not.toBeInTheDocument();
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();
  });

  it("filters logs in a focusable log region", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"));
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    await screen.findByText(/GET \/missing 404/);
    const log = screen.getByRole("log", { name: "Pod logs" });
    expect(log).toHaveAttribute("tabindex", "0");
    await user.type(screen.getByRole("textbox", { name: "Filter log lines" }), "404");
    await waitFor(() => expect(screen.queryByText(/GET \/ 200/)).not.toBeInTheDocument());
    expect(log).toHaveTextContent("GET /missing 404");
  });

  it("explains why logs are unavailable", async () => {
    await renderDetail(app("docs"), "/apps/apps/docs?tab=logs", () =>
      mocked.logs.mockRejectedValue(new Error("pod has no containers")),
    );
    expect(await screen.findByText("No logs available")).toBeInTheDocument();
    expect(screen.getByText("pod has no containers")).toBeInTheDocument();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
  });

  it("shows event times relative to now, with the absolute time as a title", async () => {
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    await renderDetail(app("docs"), "/apps/apps/docs?tab=events", () =>
      mocked.events.mockResolvedValue([
        {
          type: "Normal",
          reason: "Scheduled",
          message: "Assigned",
          kind: "Pod",
          object: "docs-abc",
          count: 1,
          lastTimestamp: at,
        },
      ]),
    );
    const time = await screen.findByText("2 min ago");
    expect(time).toHaveAttribute("title", at);
    expect(time).toHaveAttribute("datetime", at);
  });

  it("shows the manifest as YAML carrying the App's spec", async () => {
    const user = userEvent.setup();
    const a = app("docs", {
      description: "Team docs",
      landingPage: { enabled: true },
    } as Partial<App>);
    await renderDetail(a);
    await user.click(screen.getByRole("tab", { name: "Manifest" }));
    const panel = screen.getByRole("tabpanel", { name: "Manifest" });
    await waitFor(() => expect(panel).toHaveTextContent("kind: App"));
    const yaml = panel.querySelector("pre")?.textContent ?? "";
    expect(yaml).toContain("apiVersion: apps.nebari.dev/v1alpha1\nkind: App\n");
    expect(yaml).toContain("metadata:\n  name: docs\n  namespace: apps\n");
    expect(yaml).toContain("  description: Team docs\n");
    expect(yaml).toContain("    inline:\n      files:\n        index.html: hi\n");
    expect(yaml).toContain("  landingPage:\n    enabled: true");
    expect(yaml).not.toContain('"kind"');
    expect(panel).toHaveTextContent("apply with kubectl apply -f");
  });

  it("renders the page chrome while the app loads and skeletons only its values", async () => {
    mocked.getApp.mockReturnValue(new Promise(() => {}));
    mocked.logs.mockReturnValue(new Promise(() => {}));
    mocked.events.mockReturnValue(new Promise(() => {}));
    mocked.metrics.mockReturnValue(new Promise(() => {}));
    const { container } = renderAt(
      "/apps/apps/docs",
      <Route path="/apps/:namespace/:name" element={<AppDetailPage />} />,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Loading app");
    // Static chrome: back link, Edit, card titles and the tabs.
    expect(screen.getByRole("link", { name: "Apps" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/apps/apps/docs/edit",
    );
    expect(screen.getByRole("button", { name: "More actions" })).toBeDisabled();
    for (const title of ["URL", "Replicas", "CPU", "Memory"]) {
      expect(screen.getByText(title, { exact: true })).toBeInTheDocument();
    }
    for (const tab of ["Health", "Logs", "Events", "Manifest"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
    // The App's own values are placeholders: no name heading, status or URL yet.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop|Start|Wake/ })).toBeNull();
    expect(screen.queryByText("Not routed yet")).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    for (const block of container.querySelectorAll('[data-slot="skeleton"]')) {
      expect(block.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it("fades the app's values in when they replace the skeleton", async () => {
    let resolve: (a: App) => void = () => {};
    mocked.getApp.mockReturnValue(new Promise((r) => (resolve = r)));
    mocked.logs.mockResolvedValue({ logs: "" });
    mocked.events.mockResolvedValue([]);
    mocked.metrics.mockResolvedValue({ available: false, pods: [] });
    renderAt(
      "/apps/apps/docs",
      <Route path="/apps/:namespace/:name" element={<AppDetailPage />} />,
    );
    await screen.findByRole("status");
    resolve(app("docs"));
    const heading = await screen.findByRole("heading", { level: 1, name: "docs" });
    expect(heading.parentElement?.parentElement?.className).toContain(
      "motion-safe:animate-fade-in",
    );
  });

  it("shows skeletons, not empty-state text, while logs, events and metrics load", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"), "/apps/apps/docs", () => {
      mocked.logs.mockReturnValue(new Promise(() => {}));
      mocked.events.mockReturnValue(new Promise(() => {}));
      mocked.metrics.mockReturnValue(new Promise(() => {}));
    });
    // CPU and memory do not claim "unavailable" before the metrics answer.
    expect(screen.queryByText("Metrics unavailable")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    const logsPanel = screen.getByRole("tabpanel", { name: "Logs" });
    expect(within(logsPanel).getByRole("status")).toHaveTextContent("Loading logs");
    expect(within(logsPanel).queryByRole("log")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Events" }));
    const eventsPanel = screen.getByRole("tabpanel", { name: "Events" });
    expect(within(eventsPanel).getByRole("status")).toHaveTextContent("Loading events");
    expect(within(eventsPanel).queryByText("No events.")).toBeNull();
  });

  it("says when an app has no log lines yet instead of loading forever", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"), "/apps/apps/docs?tab=logs", () => {
      mocked.logs.mockResolvedValue({ logs: "" });
    });
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    expect(await screen.findByRole("log")).toHaveTextContent("No log lines yet.");
  });

  it("explains a failed load", async () => {
    mocked.getApp.mockRejectedValue(new Error("404 Not Found"));
    mocked.logs.mockResolvedValue({ logs: "" });
    mocked.events.mockResolvedValue([]);
    mocked.metrics.mockResolvedValue({ available: false, pods: [] });
    renderAt(
      "/apps/apps/gone",
      <Route path="/apps/:namespace/:name" element={<AppDetailPage />} />,
    );
    expect(await screen.findByText("Could not load app")).toBeInTheDocument();
    expect(screen.getByText(/404 Not Found/)).toBeInTheDocument();
  });
});
