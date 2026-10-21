import { describe, expect, it } from "vitest";
import { needsAttention, restartsByApp } from "@/lib/attention";
import type { App } from "@/lib/types";

const app = (name: string, phase: string) =>
  ({ name, namespace: "apps", status: { phase, conditions: [] } }) as unknown as App;

describe("attention", () => {
  it("keeps only apps that restarted, keyed by namespace/name", () => {
    const restarts = restartsByApp({
      usageAvailable: true,
      byNamespace: [],
      apps: [
        { namespace: "apps", name: "a", cpu: 0, memory: 0, restarts: 2 },
        { namespace: "apps", name: "b", cpu: 0, memory: 0, restarts: 0 },
      ],
    });
    expect([...restarts]).toEqual([["apps/a", 2]]);
    expect(restartsByApp(undefined).size).toBe(0);
  });

  it("flags Failed apps and apps that restarted", () => {
    const restarts = new Map([["apps/a", 1]]);
    expect(needsAttention(app("a", "Running"), restarts)).toBe(true);
    expect(needsAttention(app("b", "Failed"), restarts)).toBe(true);
    expect(needsAttention(app("c", "Running"), restarts)).toBe(false);
  });
});
