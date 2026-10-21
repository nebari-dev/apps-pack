import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { restartsByApp } from "@/lib/attention";

/**
 * Container restarts per App ("namespace/name") from GET /analytics/metrics,
 * polled every 10s. `error` is set when the counts could not be loaded, so a
 * caller never mistakes a failed request for "nothing restarted".
 */
export function useRestarts() {
  const metrics = useQuery({
    queryKey: ["cluster-metrics"],
    queryFn: api.clusterMetrics,
    refetchInterval: 10_000,
  });
  const restarts = useMemo(() => restartsByApp(metrics.data), [metrics.data]);
  return { restarts, loading: metrics.isLoading, error: metrics.error };
}
