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
    clusterMetrics: vi.fn(),
    listApps: vi.fn(),
    startApp: vi.fn(),
    stopApp: vi.fn(),
    deleteApp: vi.fn(),
  },
}));

const { api } = await import("@/lib/api");
const { AppsPage } = await import("@/pages/apps");
const { NotFoundPage } = await import("@/pages/not-found");
const mocked = vi.mocked(api);

function renderPage(ui: ReactElement, path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

const app = (name: string): App =>
  ({
    name,
    namespace: "apps",
    displayName: name,
    source: { type: "inline" },
    access: { public: true, subdomain: name },
    status: { phase: "Running", conditions: [] },
  }) as unknown as App;

beforeEach(() => {
  vi.resetAllMocks();
  mocked.clusterMetrics.mockResolvedValue({ usageAvailable: true, apps: [], byNamespace: [] });
});

describe("a failed request is an error, not an empty state", () => {
  it("apps page", async () => {
    mocked.listApps.mockRejectedValueOnce(new Error("401 Unauthorized")).mockResolvedValue([]);
    renderPage(<AppsPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load apps");
    expect(alert).toHaveTextContent("401 Unauthorized");
    expect(screen.queryByText(/no apps yet/i)).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(mocked.listApps).toHaveBeenCalledTimes(2));
  });

  it("the apps page's restart counts, without taking down the list", async () => {
    mocked.clusterMetrics.mockRejectedValue(new Error("503 Service Unavailable"));
    mocked.listApps.mockResolvedValue([app("one")]);
    renderPage(<AppsPage />);
    const alert = await screen.findByText("Could not check apps for restarts");
    expect(alert.closest("[data-slot=alert]")).toHaveTextContent("503 Service Unavailable");
    expect(screen.queryByText(/need attention/)).not.toBeInTheDocument();
    // The list still renders.
    expect(screen.getByRole("link", { name: "one" })).toBeInTheDocument();
  });
});

it("unknown URLs render a not-found page linking to the apps list", () => {
  renderPage(<p>home</p>, "/no/such/page");
  expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /go to apps/i })).toHaveAttribute("href", "/");
});

it("bulk actions report partial success and name the failures", async () => {
  mocked.listApps.mockResolvedValue([app("one"), app("two"), app("three")]);
  mocked.stopApp.mockImplementation(async (_ns, name) => {
    if (name === "two") throw new Error("403 you do not have access to app apps/two");
    return app(name);
  });
  renderPage(<AppsPage />);
  await screen.findAllByText("three");

  await userEvent.click(screen.getByRole("checkbox", { name: /select all/i }));
  await userEvent.click(screen.getByRole("button", { name: /^stop$/i }));

  // The toast renders its text twice (visible and in a live region).
  expect((await screen.findAllByText("2 of 3 succeeded"))[0]).toBeInTheDocument();
  expect(screen.getAllByText(/two: 403 you do not have access/)[0]).toBeInTheDocument();
  expect(mocked.stopApp).toHaveBeenCalledTimes(3);
});
