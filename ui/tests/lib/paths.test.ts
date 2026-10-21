import { describe, expect, it } from "vitest";
import { appPath, DEFAULT_NAMESPACE } from "@/lib/paths";

describe("appPath", () => {
  it("leaves the default namespace out", () => {
    expect(DEFAULT_NAMESPACE).toBe("apps");
    expect(appPath({ namespace: "apps", name: "docs-site" })).toBe("/apps/docs-site");
  });

  it("keeps any other namespace", () => {
    expect(appPath({ namespace: "team-data", name: "sales-dashboard" })).toBe(
      "/apps/team-data/sales-dashboard",
    );
  });

  it("appends a suffix segment", () => {
    expect(appPath({ namespace: "apps", name: "docs-site" }, "edit")).toBe("/apps/docs-site/edit");
    expect(appPath({ namespace: "team-data", name: "kb" }, "edit")).toBe("/apps/team-data/kb/edit");
  });

  it("ignores an empty suffix", () => {
    expect(appPath({ namespace: "apps", name: "docs-site" }, "")).toBe("/apps/docs-site");
  });
});
