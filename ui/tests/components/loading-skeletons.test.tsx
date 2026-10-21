import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  AppFormSkeleton,
  AppsTableRowsSkeleton,
  ListSkeleton,
  LoadingRegion,
  LogSkeleton,
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

/** Every Skeleton block is hidden from assistive tech, itself or by an ancestor. */
function expectHiddenSkeletons(container: HTMLElement) {
  const blocks = container.querySelectorAll('[data-slot="skeleton"]');
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(block.closest('[aria-hidden="true"]')).not.toBeNull();
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
    ["logs", <LogSkeleton key="logs" />, "Loading logs"],
    ["list", <ListSkeleton key="list" label="Loading events" />, "Loading events"],
  ] as const)("%s skeleton has one status and a hidden placeholder", (_name, el, label) => {
    const { container } = render(el);
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expectPlaceholder(container);
  });

  it("an unlabelled list skeleton adds no status of its own", () => {
    const { container } = render(<ListSkeleton />);
    expect(screen.queryByRole("status")).toBeNull();
    expectHiddenSkeletons(container);
  });

  it("fills every column of the apps table, hiding the same ones below md", () => {
    const { container } = render(
      <table>
        <tbody>
          <AppsTableRowsSkeleton rows={4} />
        </tbody>
      </table>,
    );
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const wide = [...row.querySelectorAll("td")].map((td) =>
        td.className.includes("hidden md:table-cell"),
      );
      expect(wide).toEqual([false, false, true, true, false, true, true, false]);
    }
  });

  it("keeps the edit form's labels and titles real and only placeholders the values", () => {
    const { container } = render(
      <AppFormSkeleton actions={<button type="button">Cancel</button>} />,
    );
    for (const title of ["Basics", "Source", "Runtime", "Access"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    for (const label of ["Name", "Display name", "Namespace", "App type"]) {
      expect(screen.getByText(label, { selector: "label" })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expectHiddenSkeletons(container);
  });

  it("keeps the skeleton's pulse behind prefers-reduced-motion", () => {
    const { container } = render(<LogSkeleton />);
    for (const block of container.querySelectorAll('[data-slot="skeleton"]')) {
      expect(block.className).toContain("motion-safe:animate-skeleton-pulse");
      expect(block.className).not.toMatch(/(^|\s)animate-/);
    }
  });
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe("edit page", () => {
  it("renders its heading, back link and buttons while the app loads", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getApp).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.capabilities).mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps/apps/docs/edit"]}>
          <Routes>
            <Route path="/apps/:namespace/:name/edit" element={<EditPage />} />
            <Route path="/apps/:namespace/:name" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Loading app");
    expect(screen.getByRole("heading", { level: 1, name: "Edit app" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "/apps/apps/docs");
    expect(screen.getByText("Basics")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // No form controls until the values they hold arrive.
    expect(screen.queryByRole("textbox")).toBeNull();
    expectHiddenSkeletons(container);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/apps/apps/docs");
  });
});
