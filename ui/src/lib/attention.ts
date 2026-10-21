import type { App, ClusterMetrics } from "@/lib/types";

const key = (a: { namespace: string; name: string }) => `${a.namespace}/${a.name}`;

/** Container restarts per App ("namespace/name"), only for Apps that restarted. */
export function restartsByApp(metrics: ClusterMetrics | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const u of metrics?.apps ?? []) if (u.restarts > 0) out.set(key(u), u.restarts);
  return out;
}

/**
 * Whether an App needs attention: it is Failed, or its containers restarted.
 * Restart counts come from the cluster metrics, merged in by `restarts`.
 */
export function needsAttention(app: App, restarts: Map<string, number>): boolean {
  return app.status.phase === "Failed" || (restarts.get(key(app)) ?? 0) > 0;
}
