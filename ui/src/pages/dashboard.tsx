import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, RotateCw, ScrollText } from "lucide-react";
import { Link } from "react-router-dom";
import { AppThumbnail, BarList, PhaseBadge } from "@/components/app-bits";
import { APP_ROW_CLASS, AppNameCell } from "@/components/app-name-cell";
import { Onboarding } from "@/components/onboarding";
import { errorMessage, QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useAppActions } from "@/hooks/use-app-actions";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api";
import { PHASE_SEVERITY } from "@/lib/phase";
import { listInterval } from "@/lib/polling";
import type { AnalyticsSummary, App, ClusterMetrics } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Display names for source types; `inline` is what the UI calls an upload. */
const SOURCE_LABELS: Record<string, string> = { inline: "Upload", git: "Git", pvc: "PVC" };

/** Re-key a source-type count map by its display label. */
function labelSources(bySourceType: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [type, count] of Object.entries(bySourceType)) {
    const label = SOURCE_LABELS[type] ?? type;
    out[label] = (out[label] ?? 0) + count;
  }
  return out;
}

/**
 * The phases present in the summary, most severe first, then any unknown
 * phases by name. Each phase is its own entry, never summed into another.
 */
function phaseCounts(byPhase: Record<string, number>): [string, number][] {
  const known: readonly string[] = PHASE_SEVERITY;
  const present = Object.entries(byPhase).filter(([, n]) => n > 0);
  return [
    ...PHASE_SEVERITY.flatMap((p): [string, number][] => (byPhase[p] ? [[p, byPhase[p]]] : [])),
    ...present.filter(([p]) => !known.includes(p)).sort(([a], [b]) => a.localeCompare(b)),
  ];
}

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
    .slice(0, 3);
  const attentionLoading = apps.isLoading || metrics.isLoading;
  const attention = attentionLoading ? [] : attentionItems(apps.data ?? [], metrics.data);

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

      {/* The table sits flush in the card, so drop the card's bottom padding under it. */}
      <Card className="has-[table]:pb-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle
              aria-hidden="true"
              className={cn(
                "size-4",
                attention.length > 0 ? "text-warning-foreground" : "text-muted-foreground",
              )}
            />
            Needs attention
          </CardTitle>
        </CardHeader>
        <NeedsAttention
          items={attention}
          loading={attentionLoading}
          error={metrics.error ?? apps.error}
        />
      </Card>

      {summary ? <StatsRow summary={summary} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="status">
            <TabsList aria-label="Break down apps by">
              <TabsTab value="status">Status</TabsTab>
              <TabsTab value="source">Source</TabsTab>
              <TabsTab value="namespace">Namespace</TabsTab>
            </TabsList>
            <TabsPanel value="status" className="mt-4">
              <BarList data={summary?.byPhase ?? {}} total={summary?.total ?? 0} />
            </TabsPanel>
            <TabsPanel value="source" className="mt-4">
              <BarList
                data={labelSources(summary?.bySourceType ?? {})}
                total={summary?.total ?? 0}
              />
            </TabsPanel>
            <TabsPanel value="namespace" className="mt-4">
              <BarList data={summary?.byNamespace ?? {}} total={summary?.total ?? 0} />
            </TabsPanel>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently launched</CardTitle>
          <CardAction>
            <Link
              to="/apps"
              className="inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground hover:underline"
            >
              All apps
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </CardAction>
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
            <ul aria-label="Recently launched apps" className="divide-y divide-border">
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
                  <div className="shrink-0">
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

/** One row of counts: each phase present, then replicas ready and namespaces. */
function StatsRow({ summary }: { summary: AnalyticsSummary }) {
  const entries: [string, string | number][] = [
    ...phaseCounts(summary.byPhase),
    ["replicas ready", `${summary.readyReplicas}/${summary.desiredReplicas}`],
    ["namespaces", Object.keys(summary.byNamespace).length],
  ];
  return (
    <dl aria-label="App counts" className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
      {entries.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt className="order-2 text-muted-foreground">{label}</dt>
          <dd className="order-1 font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
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
  items,
  loading,
  error,
}: {
  items: AttentionItem[];
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
