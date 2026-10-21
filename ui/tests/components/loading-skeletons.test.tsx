import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  AppDetailSkeleton,
  AppFormSkeleton,
  AppsTableSkeleton,
  ListSkeleton,
  LoadingRegion,
  LogSkeleton,
  PageSkeleton,
} from "@/components/loading-skeletons";

vi.mock("@/lib/api", () => ({
  api: { getApp: vi.fn(), capabilities: vi.fn() },
}));

const { api } = await import("@/lib/api");
const { EditPage } = await import("@/pages/edit");

/** The aria-busy placeholder: hidden from assistive tech, made of Skeleton blocks. */
function expectPlaceholder(container: HTMLElement) {
  const busy = container.querySelectorAll('[aria-busy="true"]');
  expect(busy).toHaveLength(1);
  expect(busy[0]).toHaveAttribute("aria-hidden", "true");
  expect(busy[0].querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  // The status line sits outside the busy element so it is not held back.
  expect(busy[0].querySelector('[role="status"]')).toBeNull();
}

describe("loading skeletons", () => {
  it("announces what is loading once, and hides the placeholder from assistive tech", () => {
    const { container } = render(
      <LoadingRegion label="Loading things">
        <span>placeholder</span>
      </LoadingRegion>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading things");
    expect(status).toHaveClass("sr-only");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.querySelector('[aria-busy="true"]')).toHaveAttribute("aria-hidden", "true");
  });

  it.each([
    ["page", <PageSkeleton key="page" />, "Loading page"],
    ["apps table", <AppsTableSkeleton key="table" />, "Loading apps"],
    ["app detail", <AppDetailSkeleton key="detail" />, "Loading app"],
    ["app form", <AppFormSkeleton key="form" />, "Loading app"],
    ["logs", <LogSkeleton key="logs" />, "Loading logs"],
    ["list", <ListSkeleton key="list" label="Loading events" />, "Loading events"],
  ] as [string, ReactElement, string][])(
    "%s skeleton has one status and a hidden placeholder",
    (_name, el, label) => {
      const { container } = render(el);
      expect(screen.getByRole("status")).toHaveTextContent(label);
      expectPlaceholder(container);
      // Nothing in a placeholder can take focus or be read as content.
      expect(screen.queryByRole("heading")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
    },
  );

  it("mirrors the apps table's columns, hiding the same ones below md", () => {
    const { container } = render(<AppsTableSkeleton rows={4} />);
    const heads = [...container.querySelectorAll("thead th")].map((th) => ({
      text: th.textContent,
      wide: th.className.includes("hidden md:table-cell"),
    }));
    expect(heads).toEqual([
      { text: "", wide: false },
      { text: "App", wide: false },
      { text: "Type", wide: true },
      { text: "Source", wide: true },
      { text: "Status", wide: false },
      { text: "Replicas", wide: true },
      { text: "Owner", wide: true },
      { text: "Actions", wide: false },
    ]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    for (const row of container.querySelectorAll("tbody tr")) {
      expect(row.querySelectorAll("td")).toHaveLength(heads.length);
    }
  });

  it("keeps the skeleton's pulse behind prefers-reduced-motion", () => {
    const { container } = render(<PageSkeleton />);
    for (const block of container.querySelectorAll('[data-slot="skeleton"]')) {
      expect(block.className).toContain("motion-safe:animate-skeleton-pulse");
      expect(block.className).not.toMatch(/(^|\s)animate-/);
    }
  });
});

describe("edit page", () => {
  it("shows the form's skeleton while the app loads", async () => {
    vi.mocked(api.getApp).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.capabilities).mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps/apps/docs/edit"]}>
          <Routes>
            <Route path="/apps/:namespace/:name/edit" element={<EditPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Loading app");
    expectPlaceholder(container);
    expect(screen.queryByRole("heading", { name: "Edit app" })).toBeNull();
  });
});
