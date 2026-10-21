import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toast";
import type { ApiVersion, Capabilities, Me } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: { version: vi.fn(), me: vi.fn(), capabilities: vi.fn() },
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getConfig: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

const { api } = await import("@/lib/api");
const { getConfig } = await import("@/lib/auth");
const { copyText } = await import("@/lib/clipboard");
const { SettingsPage, bugReportUrl, idleTimeoutLine, versionLine } = await import(
  "@/pages/settings"
);
const mocked = vi.mocked(api);

const VERSION: ApiVersion = { version: "0.4.0", build: "sha-api1234" };
const ME: Me = {
  username: "alice",
  email: "alice@example.com",
  groups: ["analytics"],
  admin: false,
};
const CAPS: Capabilities = {
  appsDomain: "apps.example.ai",
  sourceTypes: ["git", "inline", "image"],
  namespaces: ["apps", "team-data"],
  idleTimeoutMinutes: 120,
  imageRegistries: ["ghcr.io/example"],
};

/** A promise the test resolves later, to hold a query in its loading state. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

const region = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.mocked(getConfig).mockReturnValue({
    authEnabled: true,
    keycloak: { url: "", realm: "", clientId: "" },
    appsDomain: "apps.example.ai",
    version: "0.4.0",
    build: "sha-ui5678",
  });
  mocked.version.mockResolvedValue(VERSION);
  mocked.me.mockResolvedValue(ME);
  mocked.capabilities.mockResolvedValue(CAPS);
});

describe("SettingsPage", () => {
  it("names the page and shows the UI version at once", async () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(document.title).toContain("Settings");
    expect(within(region("About")).getByText("sha-ui5678")).toBeInTheDocument();
    expect(await within(region("About")).findByText("sha-api1234")).toBeInTheDocument();
  });

  it("renders headings and labels while the data loads, with placeholders for the values", async () => {
    const pending = deferred<Me>();
    mocked.me.mockReturnValue(pending.promise);
    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent("Loading settings");
    for (const name of ["About", "Your account", "Cluster", "Connect an agent"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    const account = region("Your account");
    expect(within(account).getByText("Username")).toBeInTheDocument();
    expect(within(account).queryByText("alice")).not.toBeInTheDocument();
    expect(account.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    pending.resolve(ME);
    expect(await within(account).findByText("alice")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(account.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("shows the account from /auth/me with a note on groups", async () => {
    renderPage();
    const account = region("Your account");
    expect(await within(account).findByText("alice")).toBeInTheDocument();
    expect(within(account).getByText("alice@example.com")).toBeInTheDocument();
    expect(within(account).getByText("analytics")).toBeInTheDocument();
    expect(within(account).getByText("No")).toBeInTheDocument();
    expect(within(account).getByText(/restricted App opens for members/)).toBeInTheDocument();
  });

  it("shows the cluster's settings from /capabilities", async () => {
    renderPage();
    const cluster = region("Cluster");
    expect(await within(cluster).findByText("apps.example.ai")).toBeInTheDocument();
    expect(within(cluster).getByText("team-data")).toBeInTheDocument();
    expect(within(cluster).getByText("2 hours")).toBeInTheDocument();
    expect(within(cluster).getByText("Upload")).toBeInTheDocument();
    expect(within(cluster).getByText("ghcr.io/example")).toBeInTheDocument();
  });

  it("says when image Apps and idling are off", async () => {
    mocked.capabilities.mockResolvedValue({
      ...CAPS,
      sourceTypes: ["git"],
      idleTimeoutMinutes: 0,
      imageRegistries: [],
    });
    renderPage();
    const cluster = region("Cluster");
    expect(await within(cluster).findByText("Image Apps are off")).toBeInTheDocument();
    expect(within(cluster).getByText(/^Off: Apps stay up/)).toBeInTheDocument();
  });

  it("shows an error with a retry when the account does not load", async () => {
    mocked.me.mockRejectedValue(new Error("token expired"));
    renderPage();
    const account = region("Your account");
    expect(await within(account).findByText("Could not load your account")).toBeInTheDocument();
    expect(within(account).getByText("token expired")).toBeInTheDocument();
    expect(within(account).getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("links a bug report with both versions, the docs and the changelog", async () => {
    renderPage();
    const about = region("About");
    await within(about).findByText("sha-api1234");
    const bug = within(about).getByRole("link", { name: /report a bug/i });
    const url = new URL(bug.getAttribute("href") ?? "");
    expect(url.searchParams.get("version")).toBe("UI 0.4.0 (sha-ui5678), API 0.4.0 (sha-api1234)");
    expect(within(about).getByRole("link", { name: /documentation/i })).toHaveAttribute(
      "href",
      "https://packs.nebari.dev/apps-pack/",
    );
    expect(within(about).getByRole("link", { name: /changelog/i })).toHaveAttribute(
      "href",
      "https://github.com/nebari-dev/apps-pack/blob/main/CHANGELOG.md",
    );
  });

  it("offers the MCP URL and the claude mcp add command to copy", async () => {
    const user = userEvent.setup();
    renderPage();
    const agent = region("Connect an agent");
    const url = `${window.location.origin}/mcp`;
    expect(within(agent).getByText(url)).toBeInTheDocument();
    const command = `claude mcp add --transport http nebari-apps ${url}`;
    expect(within(agent).getByText(command)).toBeInTheDocument();
    expect(within(agent).getByRole("link", { name: /skill docs/i })).toHaveAttribute(
      "href",
      "https://packs.nebari.dev/apps-pack/skill/",
    );

    await user.click(within(agent).getByRole("button", { name: "Copy MCP server URL" }));
    expect(copyText).toHaveBeenCalledWith(url);
    await user.click(within(agent).getByRole("button", { name: "Copy Claude Code command" }));
    expect(copyText).toHaveBeenCalledWith(command);
  });
});

describe("settings helpers", () => {
  it("formats a version with its build", () => {
    expect(versionLine("0.4.0", "sha-abc")).toBe("0.4.0 (sha-abc)");
    expect(versionLine("0.4.0", "0.4.0")).toBe("0.4.0");
    expect(versionLine(undefined, "sha-abc")).toBe("unknown");
  });

  it("builds a bug report URL before the API version arrives", () => {
    const url = new URL(bugReportUrl({ version: "0.4.0", build: "sha-ui" }));
    expect(url.searchParams.get("template")).toBe("bug-report.yml");
    expect(url.searchParams.get("version")).toBe("UI 0.4.0 (sha-ui)");
  });

  it("formats the idle timeout", () => {
    expect(idleTimeoutLine(0)).toMatch(/^Off/);
    expect(idleTimeoutLine(undefined)).toMatch(/^Off/);
    expect(idleTimeoutLine(1)).toBe("1 minute");
    expect(idleTimeoutLine(45)).toBe("45 minutes");
    expect(idleTimeoutLine(60)).toBe("1 hour");
    expect(idleTimeoutLine(180)).toBe("3 hours");
  });
});
