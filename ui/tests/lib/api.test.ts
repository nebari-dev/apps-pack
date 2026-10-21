import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/auth.ts captures window.fetch when it loads, so every test stubs fetch
// first and then imports fresh copies of the modules.
type Call = { url: string; init: RequestInit };
let calls: Call[];
let respond: (url: string) => Response;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const keycloak = {
  init: vi.fn(async () => true),
  updateToken: vi.fn(async () => true),
  login: vi.fn(),
  logout: vi.fn(async () => {}),
  authenticated: true,
  token: "tok-123",
  tokenParsed: { preferred_username: "alice", email: "alice@example.test" },
};
// A constructor (lib/auth.ts calls `new Keycloak(...)`) returning the stub.
vi.mock("keycloak-js", () => ({
  default: vi.fn(function Keycloak() {
    return keycloak;
  }),
}));

beforeEach(() => {
  calls = [];
  respond = () => json({});
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return respond(url);
    }),
  );
  keycloak.updateToken.mockClear();
  keycloak.login.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  const auth = await import("@/lib/auth");
  const { api } = await import("@/lib/api");
  return { auth, api };
}

describe("api client", () => {
  it("builds the REST paths", async () => {
    const { api } = await load();
    await api.listApps();
    await api.listApps("team a");
    await api.getApp("apps", "docs-site");
    await api.logs("apps", "docs-site", 50);
    await api.clusterMetrics();
    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/apps",
      "/api/v1/apps?namespace=team%20a",
      "/api/v1/apps/apps/docs-site",
      "/api/v1/apps/apps/docs-site/logs?lines=50",
      "/api/v1/analytics/metrics",
    ]);
  });

  it("sends JSON for create and patch, and the right verbs for actions", async () => {
    const { api } = await load();
    await api.createApp({ name: "x", namespace: "apps" } as never);
    await api.patchApp("apps", "x", { displayName: "X" });
    await api.stopApp("apps", "x");
    await api.startApp("apps", "x");
    await api.restartApp("apps", "x");
    await api.deleteApp("apps", "x");
    const [create, patch, ...actions] = calls;
    expect(create.init.method).toBe("POST");
    expect(JSON.parse(create.init.body as string)).toEqual({ name: "x", namespace: "apps" });
    expect((create.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(patch.init.method).toBe("PATCH");
    expect(JSON.parse(patch.init.body as string)).toEqual({ displayName: "X" });
    expect(actions.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST /api/v1/apps/apps/x/stop",
      "POST /api/v1/apps/apps/x/start",
      "POST /api/v1/apps/apps/x/restart",
      "DELETE /api/v1/apps/apps/x",
    ]);
  });

  it("uploads the manifest and the archive as multipart", async () => {
    const { api } = await load();
    const file = new File(["zip"], "site.zip", { type: "application/zip" });
    await api.uploadApp({ name: "x", namespace: "apps" } as never, file);
    const form = calls[0].init.body as FormData;
    expect(calls[0].url).toBe("/api/v1/apps/upload");
    expect(JSON.parse(form.get("manifest") as string)).toEqual({ name: "x", namespace: "apps" });
    expect((form.get("file") as File).name).toBe("site.zip");
    // The browser sets the multipart boundary; a manual Content-Type would break it.
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("turns error responses into FetchError with the API's detail", async () => {
    const { api, auth } = await load();
    respond = () => json({ detail: "name already taken" }, 409);
    const err = await api.getApp("apps", "x").catch((e) => e);
    expect(err).toBeInstanceOf(auth.FetchError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("name already taken");

    // FastAPI validation errors carry a list.
    respond = () => json({ detail: [{ loc: ["body", "name"], msg: "required" }] }, 422);
    const invalid = await api.getApp("apps", "x").catch((e) => e);
    expect(invalid.detail).toContain('"msg":"required"');

    // A proxy error page is not JSON.
    respond = () =>
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
    const gateway = await api.getApp("apps", "x").catch((e) => e);
    expect(gateway.status).toBe(502);
    expect(gateway.detail).toBe("<html>bad gateway</html>");

    respond = () => new Response("", { status: 500, statusText: "Internal Server Error" });
    const empty = await api.getApp("apps", "x").catch((e) => e);
    expect(empty.message).toBe("500 Internal Server Error");
  });
});

describe("auth", () => {
  it("sends no token and never loads keycloak-js with auth off", async () => {
    respond = (url) =>
      url === "/api/v1/config" ? json({ authEnabled: false, keycloak: {} }) : json([]);
    const { auth, api } = await load();
    await auth.initAuth();
    await api.listApps();
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(auth.getUser()).toBeNull();
    const Keycloak = (await import("keycloak-js")).default;
    expect(Keycloak).not.toHaveBeenCalled();
  });

  it("logs in with PKCE and sends a refreshed bearer token", async () => {
    respond = (url) =>
      url === "/api/v1/config"
        ? json({
            authEnabled: true,
            keycloak: { url: "https://kc.example.test", realm: "nebari", clientId: "apps-ui-spa" },
            appsDomain: "apps.example.test",
          })
        : json([]);
    const { auth, api } = await load();
    const config = await auth.initAuth();
    expect(config.appsDomain).toBe("apps.example.test");
    expect(keycloak.init).toHaveBeenCalledWith(
      expect.objectContaining({
        onLoad: "login-required",
        pkceMethod: "S256",
        checkLoginIframe: false,
      }),
    );

    await api.listApps();
    expect(keycloak.updateToken).toHaveBeenCalledWith(30);
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
    expect(auth.getUser()).toEqual({ name: "alice", email: "alice@example.test" });
  });

  it("sends the user back to Keycloak when the token cannot be refreshed", async () => {
    respond = (url) =>
      url === "/api/v1/config"
        ? json({ authEnabled: true, keycloak: { url: "https://kc", realm: "r", clientId: "c" } })
        : json([]);
    const { auth, api } = await load();
    await auth.initAuth();
    keycloak.updateToken.mockRejectedValueOnce(new Error("refresh token expired"));
    await api.listApps();
    expect(keycloak.login).toHaveBeenCalled();
  });

  it("boots with defaults when the API is unreachable", async () => {
    respond = () => {
      throw new TypeError("Failed to fetch");
    };
    const { auth } = await load();
    await expect(auth.initAuth()).resolves.toMatchObject({ authEnabled: false });
  });
});
