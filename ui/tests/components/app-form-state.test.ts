import { describe, expect, it } from "vitest";
import { initialState, reducer } from "@/components/app-form/state";

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
