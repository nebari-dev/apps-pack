import { useQuery } from '@tanstack/react-query';
import { Activity, Boxes, Layers, Rocket } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BarList, FrameworkBadge, PhaseBadge, StatCard } from '@/components/app-bits';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Spinner } from '@/ui/spinner';

export function DashboardPage() {
  const analytics = useQuery({ queryKey: ['analytics'], queryFn: api.analytics });
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api.listApps() });

  if (analytics.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  const summary = analytics.data;
  const recent = [...(apps.data ?? [])]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 5);
  const running = summary?.byPhase.Running ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-2xl">Dashboard</h1>
          <p className="text-muted-foreground text-sm">
            Web applications running on this Nebari cluster.
          </p>
        </div>
        <Button render={<Link to="/launch">Launch app</Link>} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total apps" value={summary?.total ?? 0} icon={<Rocket className="size-5" />} />
        <StatCard
          label="Running"
          value={running}
          hint={summary ? `${summary.total - running} not running` : undefined}
          icon={<Activity className="size-5" />}
        />
        <StatCard
          label="Replicas ready"
          value={`${summary?.readyReplicas ?? 0}/${summary?.desiredReplicas ?? 0}`}
          icon={<Boxes className="size-5" />}
        />
        <StatCard
          label="Namespaces"
          value={Object.keys(summary?.byNamespace ?? {}).length}
          icon={<Layers className="size-5" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>By status</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList data={summary?.byPhase ?? {}} total={summary?.total ?? 0} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By framework</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList data={summary?.byFramework ?? {}} total={summary?.total ?? 0} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By namespace</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList data={summary?.byNamespace ?? {}} total={summary?.total ?? 0} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recently launched</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing yet - <Link className="underline" to="/launch">launch your first app</Link>.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((app) => (
                <li key={`${app.namespace}/${app.name}`} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Link
                      to={`/apps/${app.namespace}/${app.name}`}
                      className="font-medium text-sm hover:underline"
                    >
                      {app.displayName || app.name}
                    </Link>
                    <p className="truncate text-muted-foreground text-xs">
                      {app.namespace} · {app.owner || 'unknown owner'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <FrameworkBadge framework={app.framework} />
                    <PhaseBadge phase={app.status.phase} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
