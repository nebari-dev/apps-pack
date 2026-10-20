import { describe, expect, it } from "vitest";
import { initialState, reducer, slugify, splitList, validate } from "@/components/app-form/state";
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

  it("mirrors a slug of the name, not the raw text", () => {
    let s = initialState(undefined, false);
    s = reducer(s, { type: "name", value: "Not Valid" });
    expect(s.subdomain).toBe("not-valid");
    s = reducer(s, { type: "name", value: "Not Valid 2" });
    expect(s.subdomain).toBe("not-valid-2");
  });

  it("records touched fields and a submit attempt", () => {
    let s = initialState(undefined, false);
    expect([s.touched, s.submitted]).toEqual([{}, false]);
    s = reducer(s, { type: "touch", field: "name" });
    expect(reducer(s, { type: "touch", field: "name" })).toBe(s);
    s = reducer(s, { type: "submit" });
    expect([s.touched, s.submitted]).toEqual([{ name: true }, true]);
  });

  it("fills requests and limits from a preset", () => {
    const s = reducer(initialState(undefined, false), { type: "preset", preset: "Large" });
    expect([s.cpuReq, s.memReq, s.cpuLim, s.memLim]).toEqual(["500m", "1Gi", "1", "2Gi"]);
  });
});

describe("slugify", () => {
  it.each([
    ["Sales Dashboard", "sales-dashboard"],
    ["  --My__App!!  ", "my-app"],
    ["already-fine-1", "already-fine-1"],
    ["", ""],
  ])("%j -> %j", (raw, want) => {
    expect(slugify(raw)).toBe(want);
  });
});

describe("validate", () => {
  it("returns every problem, one per field, in form order", () => {
    const s = { ...initialState(undefined, false), sourceTab: "git" as const };
    expect(validate(s, false).map((p) => p.field)).toEqual([
      "name",
      "displayName",
      "namespace",
      "gitUrl",
      "subdomain",
    ]);
    expect(validate({ ...s, kind: "pixi" }, true).map((p) => p.field)).toEqual([
      "displayName",
      "namespace",
      "pixiTask",
      "gitUrl",
    ]);
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
