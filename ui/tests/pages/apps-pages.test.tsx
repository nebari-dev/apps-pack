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

const { api } = await import("@/lib/api");
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
      replicas: { desired: phase === "Stopped" ? 0 : 1, ready: phase === "Running" ? 1 : 0 },
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
          <Route path="/apps" element={<p>apps list</p>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
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
  const renderDetail = async (a: App, path = "/apps/apps/docs") => {
    mocked.getApp.mockResolvedValue(a);
    mocked.logs.mockResolvedValue({ logs: "GET / 200\nGET /missing 404\n" });
    mocked.events.mockResolvedValue([]);
    mocked.metrics.mockResolvedValue({
      available: true,
      pods: [{ name: "p", cpu: "3m", memory: "10Mi" }],
    });
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

  it("opens the tab named by ?tab= and writes the chosen tab back to the URL", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"), "/apps/apps/docs?tab=logs");
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/GET \/missing 404/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("location")).toHaveTextContent("/apps/apps/docs?tab=events");
  });

  it("falls back to Conditions for a missing or unknown ?tab=", async () => {
    await renderDetail(app("docs"), "/apps/apps/docs?tab=nope");
    expect(screen.getByRole("tab", { name: "Conditions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("offers the URL only while Running, and Start for a stopped app", async () => {
    await renderDetail(app("docs", { phase: "Stopped" }));
    expect(screen.getByRole("button", { name: /Open/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Start/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restart/ })).toBeDisabled();
  });

  it("stops and restarts a running app", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"));
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute(
      "href",
      "https://docs.apps.example.ai",
    );
    mocked.restartApp.mockResolvedValue(app("docs"));
    await user.click(screen.getByRole("button", { name: /Restart/ }));
    expect(mocked.restartApp).toHaveBeenCalledWith("apps", "docs");
    expect(await screen.findByText("Restarting docs")).toBeInTheDocument();
  });

  it("deletes only after the name is typed, then returns to the list", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"));
    mocked.deleteApp.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: /Delete/ }));
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

  it("filters logs", async () => {
    const user = userEvent.setup();
    await renderDetail(app("docs"));
    await user.click(screen.getByRole("tab", { name: "Logs" }));
    await screen.findByText(/GET \/missing 404/);
    await user.type(screen.getByPlaceholderText("Filter lines…"), "404");
    await waitFor(() => expect(screen.queryByText(/GET \/ 200/)).not.toBeInTheDocument());
    expect(screen.getByText(/GET \/missing 404/)).toBeInTheDocument();
  });

  it("shows a manifest that round-trips the App's spec", async () => {
    const user = userEvent.setup();
    const a = app("docs", {
      description: "Team docs",
      landingPage: { enabled: true },
    } as Partial<App>);
    await renderDetail(a);
    await user.click(screen.getByRole("tab", { name: "Manifest" }));
    const code = await screen.findByText(/"kind": "App"/, { exact: false });
    const manifest = JSON.parse(code.closest("pre")?.textContent ?? code.textContent ?? "{}");
    expect(manifest.metadata).toEqual({ name: "docs", namespace: "apps" });
    expect(manifest.spec).toMatchObject({
      displayName: "docs",
      description: "Team docs",
      source: a.source,
      runtime: a.runtime,
      access: a.access,
      landingPage: { enabled: true },
    });
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
