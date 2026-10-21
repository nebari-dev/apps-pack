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

vi.mock("@/lib/branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branding")>()),
  getBranding: vi.fn(() => ({ build: "sha-ui5678" })),
}));

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

const { api } = await import("@/lib/api");
const { getConfig } = await import("@/lib/auth");
const { copyText } = await import("@/lib/clipboard");
const { getBranding } = await import("@/lib/branding");
const {
  SettingsPage,
  buildsDiffer,
  bugReportUrl,
  claudeCommand,
  idleTimeoutLine,
  uiBuild,
  versionLine,
} = await import("@/pages/settings");
const mocked = vi.mocked(api);

/** ui/package.json's version, baked in by vite.config.ts. */
const UI_VERSION = import.meta.env.UI_VERSION;
// The API on the same release and image as the UI, as after a finished rollout.
const VERSION: ApiVersion = { version: UI_VERSION, build: "sha-ui5678" };
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
    // /config carries the API's version; the UI must not show it as its own.
    version: "9.9.9",
    build: "sha-config",
  });
  vi.mocked(getBranding).mockReturnValue({ build: "sha-ui5678" });
  mocked.version.mockResolvedValue(VERSION);
  mocked.me.mockResolvedValue(ME);
  mocked.capabilities.mockResolvedValue(CAPS);
});

describe("SettingsPage", () => {
  it("names the page and shows the UI's own version and build at once", async () => {
    mocked.version.mockResolvedValue({ version: UI_VERSION, build: "sha-api1234" });
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(document.title).toContain("Settings");
    const about = region("About");
    expect(within(about).getAllByText(UI_VERSION)[0]).toBeInTheDocument();
    expect(within(about).getByText("sha-ui5678")).toBeInTheDocument();
    expect(within(about).queryByText("9.9.9")).not.toBeInTheDocument();
    expect(within(about).queryByText("sha-config")).not.toBeInTheDocument();
    expect(await within(about).findByText("sha-api1234")).toBeInTheDocument();
  });

  it("shows unknown for the UI build outside the chart", () => {
    vi.mocked(getBranding).mockReturnValue({});
    renderPage();
    expect(within(region("About")).getByText("unknown")).toBeInTheDocument();
  });

  it("does not flag matching builds", async () => {
    renderPage();
    const about = region("About");
    await within(about).findAllByText("sha-ui5678");
    expect(within(about).queryByText(/different builds/)).not.toBeInTheDocument();
  });

  it("notes when the UI and the API are on different builds", async () => {
    mocked.version.mockResolvedValue({ version: UI_VERSION, build: "sha-api1234" });
    renderPage();
    expect(
      await within(region("About")).findByText(/The UI and API are on different builds/),
    ).toBeInTheDocument();
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
    mocked.version.mockResolvedValue({ version: "0.4.0", build: "sha-api1234" });
    renderPage();
    const about = region("About");
    await within(about).findByText("sha-api1234");
    const bug = within(about).getByRole("link", { name: /report a bug/i });
    const url = new URL(bug.getAttribute("href") ?? "");
    expect(url.searchParams.get("version")).toBe(
      `UI ${UI_VERSION} (sha-ui5678), API 0.4.0 (sha-api1234)`,
    );
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
  it("adds the MCP OAuth client to the claude mcp add command when auth is on", () => {
    const url = "https://apps.example.ai/mcp";
    const base = { keycloak: { url: "", realm: "", clientId: "" }, appsDomain: "" };
    const mcpOAuth = { clientId: "nebari-apps-mcp", callbackPort: 33418 };
    expect(claudeCommand(url, { ...base, authEnabled: true, mcpOAuth })).toBe(
      `claude mcp add --transport http --client-id nebari-apps-mcp --callback-port 33418 nebari-apps ${url}`,
    );
    expect(
      claudeCommand(url, {
        ...base,
        authEnabled: true,
        mcpOAuth: { clientId: "c", callbackPort: 0 },
      }),
    ).toBe(`claude mcp add --transport http --client-id c nebari-apps ${url}`);
    expect(claudeCommand(url, { ...base, authEnabled: false, mcpOAuth })).toBe(
      `claude mcp add --transport http nebari-apps ${url}`,
    );
    expect(claudeCommand(url, { ...base, authEnabled: true })).toBe(
      `claude mcp add --transport http nebari-apps ${url}`,
    );
  });

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

  it("reads the UI's version from the bundle and its build from /config.json", () => {
    vi.mocked(getBranding).mockReturnValue({ build: "sha-ui1" });
    expect(uiBuild()).toEqual({ version: UI_VERSION, build: "sha-ui1" });
    vi.mocked(getBranding).mockReturnValue({ build: "" });
    expect(uiBuild().build).toBeUndefined();
  });

  it("compares builds only where both sides know them", () => {
    const api = { version: "0.4.0", build: "sha-a" };
    expect(buildsDiffer({ version: "0.4.0", build: "sha-a" }, api)).toBe(false);
    expect(buildsDiffer({ version: "0.4.0", build: "sha-b" }, api)).toBe(true);
    expect(buildsDiffer({ version: "0.5.0", build: "sha-a" }, api)).toBe(true);
    expect(buildsDiffer({ version: "0.4.0" }, api)).toBe(false);
    expect(buildsDiffer({ version: "0.4.0", build: "sha-b" }, { ...api, build: "unknown" })).toBe(
      false,
    );
    expect(buildsDiffer({ version: "0.4.0", build: "sha-b" })).toBe(false);
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
