import { describe, expect, it } from "vitest";
import { comparePhase, failureReason, PHASE_SEVERITY } from "@/lib/phase";

describe("phase severity", () => {
  it("orders Failed, Deploying, Pending, Running, Stopped", () => {
    expect(PHASE_SEVERITY).toEqual(["Failed", "Deploying", "Pending", "Running", "Stopped"]);
  });

  it("sorts phases by severity with unknown and empty phases last", () => {
    const phases = ["Stopped", "", "Running", "Weird", "Pending", "Failed", "Deploying"];
    expect([...phases].sort(comparePhase)).toEqual([
      "Failed",
      "Deploying",
      "Pending",
      "Running",
      "Stopped",
      "",
      "Weird",
    ]);
  });

  it("treats equal and unknown phases as equal", () => {
    expect(comparePhase("Running", "Running")).toBe(0);
    expect(comparePhase("Weird", "")).toBe(0);
    expect(comparePhase(undefined, "Weird")).toBe(0);
    expect(comparePhase("Failed", undefined)).toBeLessThan(0);
  });
});

describe("failureReason", () => {
  const cond = (status: string, reason = "", message = "") => ({ status, reason, message });

  it("prefers the first non-True condition's reason, then its message", () => {
    const conditions = [cond("True", "Valid"), cond("False", "CrashLoopBackOff", "Back-off")];
    expect(failureReason({ status: { conditions, message: "x" } })).toBe("CrashLoopBackOff");
    expect(
      failureReason({ status: { conditions: [cond("Unknown", "", "Waiting")], message: "x" } }),
    ).toBe("Waiting");
  });

  it("falls back to the status message, then empty", () => {
    const conditions = [cond("True", "Ok")];
    expect(failureReason({ status: { conditions, message: "boom" } })).toBe("boom");
    expect(failureReason({ status: {} })).toBe("");
    expect(failureReason(undefined)).toBe("");
  });
});
