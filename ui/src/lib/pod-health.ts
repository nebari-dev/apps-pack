import type { AppMetrics, PodTermination } from "@/lib/types";

/** A quantity the API normalized as a number: "12m" -> 12 (millicores), "34Mi" -> 34 (Mi). */
export function quantity(raw: string | undefined): number {
  const match = raw?.match(/^([\d.]+)/);
  return match ? Number(match[1]) : 0;
}

/** An App's pods rolled up for the Restarts and Resources cards. */
export interface PodHealth {
  pods: number;
  /** Restarts of the `app` container, summed over the pods. */
  restarts: number;
  /** The most recent previous-run termination across the pods. */
  last: PodTermination | null;
  /** The most recent container start (the youngest pod's uptime); null if none runs. */
  startedAt: string | null;
  /** One pod's limits, in millicores and Mi (0: unset); the pods share a template. */
  limitCpu: number;
  limitMemory: number;
  /** Usage summed over the pods (0 without a metrics server). */
  cpu: number;
  memory: number;
  /** The limits summed over the pods, to set usage against (0: some pod has none). */
  totalLimitCpu: number;
  totalLimitMemory: number;
}

const newest = (a: string, b: string) => (Date.parse(b) > Date.parse(a) ? b : a);

export function podHealth(metrics: AppMetrics): PodHealth {
  const { pods } = metrics;
  let last: PodTermination | null = null;
  let startedAt: string | null = null;
  for (const pod of pods) {
    const t = pod.lastTermination;
    if (t && (!last || newest(last.finishedAt, t.finishedAt) !== last.finishedAt)) last = t;
    if (pod.startedAt) startedAt = startedAt ? newest(startedAt, pod.startedAt) : pod.startedAt;
  }
  const limits = pods.map((p) => p.limits);
  const total = (key: "cpu" | "memory") =>
    limits.every((l) => quantity(l?.[key]) > 0)
      ? limits.reduce((sum, l) => sum + quantity(l?.[key]), 0)
      : 0;
  return {
    pods: pods.length,
    restarts: pods.reduce((sum, p) => sum + (p.restarts ?? 0), 0),
    last,
    startedAt,
    limitCpu: quantity(pods[0]?.limits?.cpu),
    limitMemory: quantity(pods[0]?.limits?.memory),
    cpu: pods.reduce((sum, p) => sum + quantity(p.cpu), 0),
    memory: pods.reduce((sum, p) => sum + quantity(p.memory), 0),
    totalLimitCpu: total("cpu"),
    totalLimitMemory: total("memory"),
  };
}
