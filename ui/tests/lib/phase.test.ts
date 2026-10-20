import { describe, expect, it } from "vitest";
import { comparePhase, PHASE_SEVERITY } from "@/lib/phase";

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
