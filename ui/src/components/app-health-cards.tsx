import { TriangleAlert } from "lucide-react";
import { Sparkline } from "@/components/app-bits";
import { MetricSkeleton } from "@/components/loading-skeletons";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PodHealth } from "@/lib/pod-health";
import { relativeTime, shortDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

interface HealthCardProps {
  /** The rolled-up pods; undefined while loading or when the request failed. */
  health: PodHealth | undefined;
  loading: boolean;
  /** Classes for content that replaced a skeleton (the fade-in). */
  reveal?: string;
}

/** What a card says instead of its values: still loading, failed, or no pods. */
function Placeholder({ health, loading }: HealthCardProps) {
  if (loading) return <MetricSkeleton />;
  return (
    <p className="text-muted-foreground text-sm">
      {health ? "No pods running" : "Pod status unavailable"}
    </p>
  );
}

/** Container restarts, how the last run ended, and uptime, from pod status. */
export function RestartsCard({ health, loading, reveal }: HealthCardProps) {
  const last = health?.last;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Restarts</CardTitle>
      </CardHeader>
      <CardContent>
        {loading || !health || health.pods === 0 ? (
          <Placeholder health={health} loading={loading} />
        ) : (
          <div className={cn(reveal)}>
            <p className="font-semibold text-2xl tabular-nums">{health.restarts}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {health.startedAt ? `Up ${shortDuration(health.startedAt)}` : "Not running"}
            </p>
            {last ? (
              <p className="mt-1 text-muted-foreground text-xs">
                Last: <span className="font-medium text-foreground">{lastReason(last)}</span>
                {last.finishedAt ? (
                  <>
                    {" · "}
                    <time dateTime={last.finishedAt} title={last.finishedAt}>
                      {relativeTime(last.finishedAt)}
                    </time>
                  </>
                ) : null}
              </p>
            ) : null}
            {last?.reason === "OOMKilled" ? (
              <p className="mt-2 flex items-start gap-1.5 text-muted-foreground text-xs">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-px size-3.5 shrink-0 text-warning-foreground"
                />
                Ran out of memory: the memory limit may be too low.
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function lastReason({ reason, exitCode }: { reason: string; exitCode: number }) {
  if (reason) return reason;
  return `exit code ${exitCode}`;
}

const cpuText = (milli: number) => (milli ? `${milli}m` : "no limit");
const memText = (mi: number) => (mi ? `${mi} Mi` : "no limit");

/**
 * The `app` container's limits, always (from the pod spec), and live usage
 * against them with a short history when the cluster has a metrics server.
 */
export function ResourcesCard({
  health,
  loading,
  reveal,
  usageAvailable,
  cpuHistory,
  memHistory,
}: HealthCardProps & { usageAvailable: boolean; cpuHistory: number[]; memHistory: number[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Resources</CardTitle>
      </CardHeader>
      <CardContent>
        {loading || !health || health.pods === 0 ? (
          <Placeholder health={health} loading={loading} />
        ) : (
          <div className={cn(reveal)}>
            <p className="text-muted-foreground text-xs">
              {health.pods > 1 ? "Limits per pod" : "Limits"}
            </p>
            <p className="font-medium text-sm tabular-nums">
              CPU {cpuText(health.limitCpu)} · Memory {memText(health.limitMemory)}
            </p>
            {usageAvailable ? (
              <dl className="mt-2 space-y-2 text-xs">
                <UsageRow
                  label="CPU"
                  value={
                    health.totalLimitCpu
                      ? `${health.cpu} / ${health.totalLimitCpu}m`
                      : `${health.cpu}m`
                  }
                  history={cpuHistory}
                />
                <UsageRow
                  label="Memory"
                  value={
                    health.totalLimitMemory
                      ? `${health.memory} / ${health.totalLimitMemory} Mi`
                      : `${health.memory} Mi`
                  }
                  history={memHistory}
                />
              </dl>
            ) : (
              <p className="mt-2 text-muted-foreground text-xs">Live usage needs metrics-server</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageRow({ label, value, history }: { label: string; value: string; history: number[] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
      <dd className="col-span-2 mt-1">
        <Sparkline data={history} height={20} className="w-full" />
      </dd>
    </div>
  );
}
