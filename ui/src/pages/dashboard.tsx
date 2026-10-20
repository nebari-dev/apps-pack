import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Boxes, Layers, Rocket, RotateCw, ScrollText } from "lucide-react";
import { Link } from "react-router-dom";
import {
  AppThumbnail,
  BarList,
  KindBadge,
  PhaseBadge,
  SourceBadge,
  StatCard,
} from "@/components/app-bits";
import { APP_ROW_CLASS, AppNameCell } from "@/components/app-name-cell";
import { Onboarding } from "@/components/onboarding";
import { errorMessage, QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppActions } from "@/hooks/use-app-actions";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api";
import { listInterval } from "@/lib/polling";
import type { App, ClusterMetrics } from "@/lib/types";

export function DashboardPage() {
  const heading = usePageTitle("Dashboard");
  const analytics = useQuery({
    queryKey: ["analytics"],
    queryFn: api.analytics,
    refetchInterval: 30_000,
  });
  const apps = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: (q) => listInterval(q.state.data),
  });
  const metrics = useQuery({
    queryKey: ["cluster-metrics"],
    queryFn: api.clusterMetrics,
    refetchInterval: 10_000,
  });

  if (analytics.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (analytics.isError) {
    return (
      <div className="space-y-6">
        <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
          Dashboard
        </h1>
        <QueryError
          title="Could not load the dashboard"
          error={analytics.error}
          onRetry={() => void analytics.refetch()}
        />
      </div>
    );
  }

  const summary = analytics.data;
  const recent = [...(apps.data ?? [])]
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, 5);
  const running = summary?.byPhase.Running ?? 0;

  if (summary && summary.total === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
            Dashboard
          </h1>
          <p className="text-muted-foreground text-sm">
            Web applications running on this Nebari cluster.
          </p>
        </div>
        <Onboarding />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
            Dashboard
          </h1>
          <p className="text-muted-foreground text-sm">
            Web applications running on this Nebari cluster.
          </p>
        </div>
        <Button render={<Link to="/launch">Launch app</Link>} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total apps"
          value={summary?.total ?? 0}
          icon={<Rocket className="size-5" />}
        />
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

      {/* The table sits flush in the card, so drop the card's bottom padding under it. */}
      <Card className="has-[table]:pb-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle aria-hidden="true" className="size-4 text-muted-foreground" />
            Needs attention
          </CardTitle>
        </CardHeader>
        <NeedsAttention
          apps={apps.data}
          metrics={metrics.data}
          loading={apps.isLoading || metrics.isLoading}
          error={metrics.error ?? apps.error}
        />
      </Card>

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
            <CardTitle>By source</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList data={summary?.bySourceType ?? {}} total={summary?.total ?? 0} />
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
              Nothing yet -{" "}
              <Link className="underline" to="/launch">
                launch your first app
              </Link>
              .
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((app) => (
                <li
                  key={`${app.namespace}/${app.name}`}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <AppThumbnail
                      name={app.name}
                      displayName={app.displayName}
                      thumbnail={app.thumbnail}
                      className="size-8"
                    />
                    <div className="min-w-0">
                      <Link
                        to={`/apps/${app.namespace}/${app.name}`}
                        className="font-medium text-sm hover:underline"
                      >
                        {app.displayName || app.name}
                      </Link>
                      <p className="truncate text-muted-foreground text-xs">
                        {app.namespace} · {app.owner || "unknown owner"}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <SourceBadge source={app.source?.type ?? "—"} />
                    <KindBadge pixiTask={app.runtime?.pixiTask} />
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

interface AttentionItem {
  namespace: string;
  name: string;
  /** The App, when the apps list has it; restarts can be known from metrics alone. */
  app?: App;
  failed: boolean;
  restarts: number;
}

/**
 * Apps in the Failed phase merged with apps whose containers restarted, one row
 * per app, failed first and then by restart count.
 */
function attentionItems(apps: App[], metrics: ClusterMetrics | undefined): AttentionItem[] {
  const byKey = new Map(apps.map((a) => [appKey(a), a]));
  const items = new Map<string, AttentionItem>();
  const item = (a: { namespace: string; name: string }) => {
    const key = appKey(a);
    const found = items.get(key);
    if (found) return found;
    const created: AttentionItem = {
      namespace: a.namespace,
      name: a.name,
      app: byKey.get(key),
      failed: false,
      restarts: 0,
    };
    items.set(key, created);
    return created;
  };
  for (const a of apps) if (a.status.phase === "Failed") item(a).failed = true;
  for (const u of metrics?.apps ?? []) if (u.restarts > 0) item(u).restarts = u.restarts;
  return [...items.values()].sort(
    (a, b) => Number(b.failed) - Number(a.failed) || b.restarts - a.restarts,
  );
}

const appKey = (a: { namespace: string; name: string }) => `${a.namespace}/${a.name}`;

/** Why a Failed App failed: its first condition that is not True, else the status message. */
function failureReason(app: App | undefined): string {
  if (!app) return "";
  const failing = (app.status.conditions ?? []).find((c) => c.status !== "True");
  return failing?.reason || failing?.message || app.status.message || "";
}

function NeedsAttention({
  apps,
  metrics,
  loading,
  error,
}: {
  apps: App[] | undefined;
  metrics: ClusterMetrics | undefined;
  loading: boolean;
  error: unknown;
}) {
  const actions = useAppActions();
  if (loading) {
    return (
      <CardContent className="flex h-16 items-center justify-center">
        <Spinner className="size-5" />
      </CardContent>
    );
  }
  const items = attentionItems(apps ?? [], metrics);
  return (
    <>
      {/* A failed request still lists what is known, but never claims the all-clear. */}
      {error ? (
        <CardContent>
          <p role="alert" className="text-destructive-foreground text-sm">
            Could not check every app: {errorMessage(error)}
          </p>
        </CardContent>
      ) : null}
      {items.length === 0 && !error ? (
        <CardContent>
          <p className="text-muted-foreground text-sm">
            Everything is running — no restarts or failed apps.
          </p>
        </CardContent>
      ) : null}
      {items.length > 0 ? (
        <CardContent className="px-0">
          <Table
            aria-label="Apps that need attention"
            scrollContainerClassName="rounded-none border-x-0 border-b-0"
          >
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Restarts</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const { app } = item;
                const phase = app?.status.phase ?? "";
                const label = app?.displayName || item.name;
                const reason = item.failed ? failureReason(app) : "";
                return (
                  <TableRow key={appKey(item)} data-phase={phase} className={APP_ROW_CLASS}>
                    <TableCell>
                      <AppNameCell
                        app={app ?? { namespace: item.namespace, name: item.name }}
                        subline={`${item.name} · ${item.namespace}`}
                      />
                    </TableCell>
                    <TableCell>
                      {phase ? <PhaseBadge phase={phase} /> : "—"}
                      {reason ? (
                        <p className="mt-1 text-muted-foreground text-xs">{reason}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{item.restarts || "—"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          render={
                            <Link
                              to={`/apps/${item.namespace}/${item.name}?tab=logs`}
                              aria-label={`Logs for ${label}`}
                            />
                          }
                        >
                          <ScrollText aria-hidden="true" />
                          Logs
                        </Button>
                        {item.failed && app ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Restart ${label}`}
                            loading={actions.isPendingFor(actions.restart, app)}
                            onClick={() => actions.restart.mutate(app)}
                          >
                            <RotateCw aria-hidden="true" />
                            Restart
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      ) : null}
    </>
  );
}
