import { describe, expect, it } from "vitest";
import { podHealth, quantity } from "@/lib/pod-health";
import type { PodMetric } from "@/lib/types";

const pod = (over: Partial<PodMetric> = {}): PodMetric => ({
  name: "p",
  cpu: "",
  memory: "",
  restarts: 0,
  lastTermination: null,
  startedAt: null,
  limits: { cpu: "500m", memory: "512Mi" },
  requests: { cpu: "100m", memory: "128Mi" },
  ...over,
});

describe("quantity", () => {
  it.each([
    ["12m", 12],
    ["34Mi", 34],
    ["1.5", 1.5],
    ["", 0],
    [undefined, 0],
  ])("%s is %d", (raw, expected) => {
    expect(quantity(raw)).toBe(expected);
  });
});

describe("podHealth", () => {
  it("is empty for no pods", () => {
    expect(podHealth({ available: false, pods: [] })).toMatchObject({
      pods: 0,
      restarts: 0,
      last: null,
      startedAt: null,
      limitCpu: 0,
      totalLimitCpu: 0,
    });
  });

  it("sums restarts and usage, keeps the newest termination and start", () => {
    const old = { reason: "Error", exitCode: 1, finishedAt: "2026-10-20T10:00:00Z" };
    const oom = { reason: "OOMKilled", exitCode: 137, finishedAt: "2026-10-20T11:00:00Z" };
    const health = podHealth({
      available: true,
      pods: [
        pod({
          cpu: "10m",
          memory: "100Mi",
          restarts: 2,
          lastTermination: oom,
          startedAt: "2026-10-20T11:00:05Z",
        }),
        pod({
          cpu: "5m",
          memory: "50Mi",
          restarts: 1,
          lastTermination: old,
          startedAt: "2026-10-19T00:00:00Z",
        }),
      ],
    });
    expect(health).toEqual({
      pods: 2,
      restarts: 3,
      last: oom,
      startedAt: "2026-10-20T11:00:05Z",
      limitCpu: 500,
      limitMemory: 512,
      cpu: 15,
      memory: 150,
      totalLimitCpu: 1000,
      totalLimitMemory: 1024,
    });
  });

  it("has no total limit when a pod has none, and tolerates an older API without pod health", () => {
    const health = podHealth({
      available: true,
      pods: [pod(), { name: "q", cpu: "1m", memory: "2Mi" }],
    });
    expect(health.totalLimitCpu).toBe(0);
    expect(health.totalLimitMemory).toBe(0);
    expect(health.restarts).toBe(0);
    expect(health.cpu).toBe(1);
  });
});
