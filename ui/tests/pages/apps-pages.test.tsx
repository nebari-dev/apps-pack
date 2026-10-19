import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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

  const renderApps = async () => {
    mocked.listApps.mockResolvedValue(LIST);
    renderAt("/", <Route path="/" element={<AppsPage />} />);
    await screen.findByRole("link", { name: "Alpha Docs" });
  };

  it("lists apps sorted by name and sorts by a column on click", async () => {
    const user = userEvent.setup();
    await renderApps();
    expect(names()).toEqual(["Alpha Docs", "beta", "gamma"]);

    const status = screen.getByRole("button", { name: /Status/ });
    await user.click(status);
    expect(status.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(names()).toEqual(["gamma", "Alpha Docs", "beta"]);
    await user.click(status);
    expect(status.closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(names()).toEqual(["beta", "Alpha Docs", "gamma"]);
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

describe("app detail page", () => {
  const renderDetail = async (a: App) => {
    mocked.getApp.mockResolvedValue(a);
    mocked.logs.mockResolvedValue({ logs: "GET / 200\nGET /missing 404\n" });
    mocked.events.mockResolvedValue([]);
    mocked.metrics.mockResolvedValue({
      available: true,
      pods: [{ name: "p", cpu: "3m", memory: "10Mi" }],
    });
    renderAt(
      "/apps/apps/docs",
      <Route path="/apps/:namespace/:name" element={<AppDetailPage />} />,
    );
    await screen.findByRole("heading", { level: 1 });
  };

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
