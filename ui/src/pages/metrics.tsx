import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Cpu, Gauge, LineChart, MemoryStick, Network, TrendingUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import type { App } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

export function MetricsPage() {
  const metrics = useQuery({
    queryKey: ['cluster-metrics'],
    queryFn: api.clusterMetrics,
    refetchInterval: 10_000,
  });
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api.listApps() });

  if (metrics.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  const data = metrics.data;
  const usage = data?.usageAvailable ?? false;
  const topCpu = (data?.apps ?? []).filter((a) => a.cpu > 0).slice(0, 8);
  const topMem = [...(data?.apps ?? [])].filter((a) => a.memory > 0).sort((a, b) => b.memory - a.memory).slice(0, 8);
  const nsUsage = data?.byNamespace ?? [];
  const restarts = [...(data?.apps ?? [])].filter((a) => a.restarts > 0).sort((a, b) => b.restarts - a.restarts);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-2xl">Metrics</h1>
        <p className="text-muted-foreground text-sm">
          Right-now resource usage and health across every app on the cluster.
        </p>
      </div>

      {/* #8 — resource leaderboard */}
      {usage ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <Cpu className="size-4 text-muted-foreground" />
              <CardTitle>Top apps by CPU</CardTitle>
            </CardHeader>
            <CardContent>
              <MetricBars items={topCpu.map((a) => ({ key: appKey(a), label: a.name, value: a.cpu }))} unit="m" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <MemoryStick className="size-4 text-muted-foreground" />
              <CardTitle>Top apps by memory</CardTitle>
            </CardHeader>
            <CardContent>
              <MetricBars items={topMem.map((a) => ({ key: appKey(a), label: a.name, value: a.memory }))} unit="Mi" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <Gauge className="size-4 text-muted-foreground" />
              <CardTitle>By namespace (CPU)</CardTitle>
            </CardHeader>
            <CardContent>
              <MetricBars items={nsUsage.map((n) => ({ key: n.namespace, label: n.namespace, value: n.cpu, hint: `${n.memory}Mi` }))} unit="m" />
            </CardContent>
          </Card>
        </div>
      ) : (
        <Placeholder
          icon={<Gauge className="size-5" />}
          title="Live resource usage unavailable"
          body="CPU and memory come from the Kubernetes metrics server (metrics.k8s.io), which isn't installed on this cluster. Install metrics-server to populate the resource leaderboard. Restart counts below don't need it."
        />
      )}

      {/* #11 (part) — crashloop / restart watch */}
      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <AlertTriangle className="size-4 text-muted-foreground" />
          <CardTitle>Restart watch</CardTitle>
        </CardHeader>
        <CardContent>
          {restarts.length === 0 ? (
            <p className="text-muted-foreground text-sm">No container restarts — every app is stable.</p>
          ) : (
            <ul className="divide-y divide-border">
              {restarts.map((a) => {
                const hot = a.restarts >= 3;
                return (
                  <li key={appKey(a)} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link to={`/apps/${a.namespace}/${a.name}`} className="font-medium text-sm hover:underline">
                        {a.name}
                      </Link>
                      <p className="text-muted-foreground text-xs">{a.namespace}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 font-medium text-xs tabular-nums ${
                        hot ? 'bg-destructive/15 text-destructive-foreground' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {a.restarts} restart{a.restarts === 1 ? '' : 's'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* #11 (part) — launches over time */}
      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <TrendingUp className="size-4 text-muted-foreground" />
          <CardTitle>Apps launched over time</CardTitle>
        </CardHeader>
        <CardContent>
          {apps.isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <MetricBars items={launchBuckets(apps.data ?? [])} unit="" />
          )}
        </CardContent>
      </Card>

      {/* #9 / #10 — require a metrics backend not present on this cluster */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Placeholder
          icon={<LineChart className="size-5" />}
          title="Historical CPU & memory"
          body="Per-app usage trends over hours and days need a time-series store. Wire up a Prometheus datasource (scraping metrics-server / cAdvisor) and this becomes a real range-selectable chart. Today's live values are on each app's detail page."
        />
        <Placeholder
          icon={<Network className="size-5" />}
          title="Traffic & health"
          body="Request volume, status codes, and p50/p95 latency per app come from the Envoy gateway's metrics. Enable Envoy Gateway's Prometheus/metrics endpoint and this shows who's using each app and where it's erroring."
        />
      </div>
    </div>
  );
}

const appKey = (a: { namespace: string; name: string }) => `${a.namespace}/${a.name}`;

interface BarItem {
  key: string;
  label: string;
  value: number;
  hint?: string;
}

/** Horizontal bars that preserve the given order (unlike the dashboard's sorted BarList). */
function MetricBars({ items, unit }: { items: BarItem[]; unit: string }) {
  if (items.length === 0) return <p className="text-muted-foreground text-sm">No data yet.</p>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.key}>
          <div className="mb-1 flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{i.label}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {i.value}
              {unit}
              {i.hint ? ` · ${i.hint}` : ''}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (i.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Placeholder({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex items-start gap-3 p-5">
        <span className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground">{icon}</span>
        <div>
          <h3 className="font-medium text-sm">{title}</h3>
          <p className="mt-1 text-muted-foreground text-sm">{body}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Bucket app creation timestamps into ISO weeks (Monday-anchored), gap-filled. */
function launchBuckets(apps: App[]): BarItem[] {
  const dates = apps
    .map((a) => new Date(a.createdAt))
    .filter((d) => !Number.isNaN(d.getTime()));
  if (dates.length === 0) return [];

  const monday = (d: Date) => {
    const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = (c.getUTCDay() + 6) % 7; // 0 = Monday
    c.setUTCDate(c.getUTCDate() - day);
    return c;
  };
  const counts = new Map<number, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const d of dates) {
    const wk = monday(d).getTime();
    counts.set(wk, (counts.get(wk) ?? 0) + 1);
    if (wk < min) min = wk;
    if (wk > max) max = wk;
  }

  const week = 7 * 24 * 60 * 60 * 1000;
  const out: BarItem[] = [];
  for (let t = min; t <= max; t += week) {
    const label = new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    out.push({ key: String(t), label, value: counts.get(t) ?? 0 });
  }
  return out;
}
