import { describe, expect, it } from "vitest";
import { isSettled, listInterval, pollFor } from "@/lib/polling";

describe("polling", () => {
  it("treats Running, Stopped and Failed as settled", () => {
    for (const phase of ["Running", "Stopped", "Failed"]) expect(isSettled(phase)).toBe(true);
    for (const phase of ["Pending", "Deploying", "", undefined])
      expect(isSettled(phase)).toBe(false);
  });

  it("polls fast until every phase has settled", () => {
    expect(pollFor(["Running", "Deploying"], 5_000, 30_000)).toBe(5_000);
    expect(pollFor(["Running", "Stopped"], 5_000, 30_000)).toBe(30_000);
    expect(pollFor([undefined], 5_000, false)).toBe(5_000);
    expect(pollFor(["Stopped"], 5_000, false)).toBe(false);
  });

  it("backs a list off once nothing is moving", () => {
    expect(listInterval(undefined)).toBe(30_000);
    expect(listInterval([])).toBe(30_000);
    expect(listInterval([{ status: { phase: "Running" } }, { status: { phase: "Pending" } }])).toBe(
      5_000,
    );
    expect(listInterval([{ status: { phase: "Running" } }])).toBe(30_000);
  });
});
