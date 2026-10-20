import { describe, expect, it } from "vitest";
import { initialState, reducer, splitList } from "@/components/app-form/state";
import { accessLine } from "@/lib/access";
import type { App } from "@/lib/types";

describe("AppForm reducer", () => {
  it("keeps the subdomain in step with the name until the user edits it", () => {
    let s = initialState(undefined, false);
    s = reducer(s, { type: "name", value: "sales" });
    expect(s.subdomain).toBe("sales");
    s = reducer(s, { type: "name", value: "sales-2" });
    expect(s.subdomain).toBe("sales-2");
    s = reducer(s, { type: "set", field: "subdomain", value: "reports" });
    s = reducer(s, { type: "name", value: "sales-3" });
    expect(s.subdomain).toBe("reports");
  });

  it("fills requests and limits from a preset", () => {
    const s = reducer(initialState(undefined, false), { type: "preset", preset: "Large" });
    expect([s.cpuReq, s.memReq, s.cpuLim, s.memLim]).toEqual(["500m", "1Gi", "1", "2Gi"]);
  });
});

describe("splitList", () => {
  it("splits on commas, trims and drops blanks", () => {
    expect(splitList(" alice, bob ,,carol,")).toEqual(["alice", "bob", "carol"]);
    expect(splitList("  ")).toEqual([]);
  });
});

describe("initialState", () => {
  it("joins the App's groups and users for editing", () => {
    const s = initialState(
      { access: { public: false, groups: ["a", "b"], users: ["alice"], subdomain: "x" } } as App,
      true,
    );
    expect([s.groups, s.users]).toEqual(["a, b", "alice"]);
  });
});

describe("accessLine", () => {
  const app = (access: App["access"]) => ({ access }) as App;
  it.each([
    [{ public: true, subdomain: "x" }, "Public - no authentication"],
    [{ public: false, subdomain: "x" }, "Keycloak SSO at the gateway · any signed-in user"],
    [
      { public: false, groups: ["a", "b"], subdomain: "x" },
      "Keycloak SSO at the gateway · restricted to groups: a, b",
    ],
    [
      { public: false, groups: ["a"], users: ["alice"], subdomain: "x" },
      "Keycloak SSO at the gateway · restricted to groups: a · users: alice",
    ],
    [
      { public: false, users: ["alice", "bob"], subdomain: "x" },
      "Keycloak SSO at the gateway · restricted to users: alice, bob",
    ],
  ])("describes %o", (access, want) => {
    expect(accessLine(app(access))).toBe(want);
  });
});
