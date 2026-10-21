import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Moon,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AppThumbnail,
  ConfirmDeleteDialog,
  KindBadge,
  PhaseBadge,
  SourceBadge,
} from "@/components/app-bits";
import { ResourcesCard, RestartsCard } from "@/components/app-health-cards";
import {
  ListSkeleton,
  LoadingStatus,
  LogSkeleton,
  PillSkeleton,
  TextLine,
} from "@/components/loading-skeletons";
import { errorMessage } from "@/components/query-error";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock, CodeBlockBody } from "@/components/ui/code-block";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { isIdle, isStopped, useAppActions } from "@/hooks/use-app-actions";
import { useArrived, useChanged } from "@/hooks/use-changed";
import { usePageTitle } from "@/hooks/use-page-title";
import { accessLine, managersLine, roleNote } from "@/lib/access";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { ENTER, FADE_IN } from "@/lib/motion";
import { appPath, DEFAULT_NAMESPACE } from "@/lib/paths";
import { podHealth } from "@/lib/pod-health";
import { pollFor } from "@/lib/polling";
import { relativeTime } from "@/lib/time";
import type { App } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toYaml } from "@/lib/yaml";

const MAX_SAMPLES = 30;

/** The detail tabs, selectable by `?tab=` so other pages can link straight to one. */
const TABS = ["conditions", "logs", "events", "manifest"] as const;
type DetailTab = (typeof TABS)[number];
const isDetailTab = (value: unknown): value is DetailTab => TABS.includes(value as DetailTab);

export function AppDetailPage() {
  const { namespace = DEFAULT_NAMESPACE, name = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: DetailTab = isDetailTab(tabParam) ? tabParam : "conditions";
  const selectTab = (next: DetailTab) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [logFollow, setLogFollow] = useState(true);
  const [logSearch, setLogSearch] = useState("");
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);

  const heading = usePageTitle(name);
  const app = useQuery({
    queryKey: ["app", namespace, name],
    queryFn: () => api.getApp(namespace, name),
    refetchInterval: (q) => pollFor([q.state.data], 5_000, 30_000),
  });
  const phase = app.data?.status.phase;
  // Stopped and idle apps have no pods: nothing to follow or measure.
  const phaseStopped = phase === "Stopped" || phase === "Idle";
  const logs = useQuery({
    queryKey: ["logs", namespace, name],
    queryFn: () => api.logs(namespace, name, 500),
    refetchInterval: logFollow && !phaseStopped ? 3_000 : false,
    retry: false,
  });
  const events = useQuery({
    queryKey: ["events", namespace, name],
    queryFn: () => api.events(namespace, name),
    refetchInterval: () => pollFor([app.data], 10_000, 60_000),
  });
  const metrics = useQuery({
    queryKey: ["metrics", namespace, name],
    queryFn: () => api.metrics(namespace, name),
    refetchInterval: () => (phaseStopped ? false : pollFor([app.data], 5_000, 15_000)),
    retry: false,
  });

  // Pod health (restarts, limits) comes with every answer; usage only when
  // the cluster has a metrics server. Roll usage into a short client-side
  // history for the sparklines.
  const sample = metrics.data;
  const health = useMemo(() => (sample ? podHealth(sample) : undefined), [sample]);
  useEffect(() => {
    if (!sample?.available || !health) return;
    setCpuHistory((h) => [...h, health.cpu].slice(-MAX_SAMPLES));
    setMemHistory((h) => [...h, health.memory].slice(-MAX_SAMPLES));
  }, [sample, health]);

  const { start, stop, restart, remove } = useAppActions({
    onDeleted: () => void navigate("/"),
  });

  // Motion: values that replaced a skeleton fade in, a status the App moved
  // into (Idle, waking, Failed) eases its alert in, and a newly picked tab
  // fades its panel. None of it plays on the first paint.
  const arrived = useArrived(app.data !== undefined);
  const reveal = arrived ? FADE_IN : undefined;
  const phaseChanged = useChanged(phase);
  const tabChanged = useChanged(tab);
  const metricsArrived = useArrived(metrics.data !== undefined);

  if (app.isError || (!app.isLoading && !app.data)) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load app</AlertTitle>
        <AlertDescription>{String(app.error ?? "not found")}</AlertDescription>
      </Alert>
    );
  }

  // Undefined while the App loads: the page's chrome (back link, Edit, card
  // titles, tabs) renders at once and only the App's own values are skeletons.
  const a = app.data;
  const stopped = a ? isStopped(a) : false;
  const idle = a ? isIdle(a) : false;
  // Only offer the app's URL while it can actually serve: stopped or
  // still-deploying apps would just show a gateway error. An idle app's URL
  // wakes it and shows a starting page meanwhile.
  const ready = a?.status.phase === "Running" || idle;
  const failure = a ? failureOf(a) : null;
  // A stopped or idle app has no pods: say so instead of drawing empty
  // Restarts and Resources cards. A failed app keeps them, since its
  // crash-looping pods are what they explain. While loading, assume pods.
  const showUsage = a?.status.phase !== "Stopped" && !idle;
  const url = a?.status.url;
  const copyUrl = async () => {
    if (!url) return;
    try {
      await copyText(url);
      toast.add({ type: "success", title: "Copied the URL" });
    } catch {
      toast.add({ type: "error", title: "Could not copy to clipboard" });
    }
  };

  const filteredLogs = filterLogs(logs.data?.logs ?? "", logSearch);
  const downloadLogs = () => {
    const blob = new Blob([logs.data?.logs ?? ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-logs.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {a ? null : <LoadingStatus label="Loading app" />}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 gap-4">
          {a ? (
            <AppThumbnail
              name={a.name}
              displayName={a.displayName}
              thumbnail={a.thumbnail}
              className={cn("mt-6 size-12", reveal)}
            />
          ) : (
            <Skeleton className="mt-6 size-12 rounded-md" />
          )}
          <div className="min-w-0 flex-1">
            <Link
              to="/"
              className="mb-1 inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Apps
            </Link>
            {a ? (
              <div className={cn(reveal)}>
                <div className="flex flex-wrap items-center gap-3">
                  {/* The heading renders with the App, so focus lands on its name. */}
                  <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
                    {a.displayName || a.name}
                  </h1>
                  <SourceBadge source={a.source?.type ?? "—"} />
                  <KindBadge pixiTask={a.runtime?.pixiTask} />
                  <PhaseBadge phase={a.status.phase} />
                </div>
                <p className="mt-1 text-muted-foreground text-sm">
                  {a.namespace}/{a.name}
                  {a.owner ? <> · launched by {a.owner}</> : null}
                  {a.description ? <> · {a.description}</> : null}
                </p>
                <p data-testid="managers" className="mt-1 text-muted-foreground text-sm">
                  Managed by {managersLine(a)}
                  {roleNote(a) ? <> · {roleNote(a)}</> : null}
                </p>
              </div>
            ) : (
              <div aria-hidden="true">
                <div className="flex flex-wrap items-center gap-3">
                  <TextLine box="h-8" className="h-6 w-48" />
                  <PillSkeleton className="w-12" />
                  <PillSkeleton className="w-20" />
                </div>
                <TextLine className="mt-1 w-80 max-w-full" />
                <TextLine className="mt-1 w-56 max-w-full" />
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          {a ? null : <Skeleton className="h-8 w-20 rounded-md" />}
          {ready && url ? (
            <Button
              render={
                <a href={url} target="_blank" rel="noreferrer">
                  Open <ExternalLink />
                </a>
              }
            />
          ) : null}
          {a && idle ? (
            <Button variant="outline" loading={start.isPending} onClick={() => start.mutate(a)}>
              <Play /> Wake
            </Button>
          ) : null}
          {!a ? null : stopped ? (
            <Button variant="outline" loading={start.isPending} onClick={() => start.mutate(a)}>
              <Play /> Start
            </Button>
          ) : (
            <Button variant="outline" loading={stop.isPending} onClick={() => stop.mutate(a)}>
              <Pause /> Stop
            </Button>
          )}
          <Button
            variant="outline"
            render={
              <Link to={appPath({ namespace, name }, "edit")}>
                Edit <Pencil />
              </Link>
            }
          />
          {a ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                variant="ghost"
                aria-label="More actions"
                render={<Button variant="ghost" size="icon" />}
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuPortal>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={stopped || idle} onClick={() => restart.mutate(a)}>
                    <RotateCw aria-hidden="true" className="size-4 shrink-0" />
                    <span className="flex flex-col">
                      Restart
                      {stopped || idle ? (
                        <span className="text-muted-foreground text-xs">
                          {idle ? "Wake the app to restart it" : "Start the app to restart it"}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={!url} onClick={() => void copyUrl()}>
                    <Copy aria-hidden="true" className="size-4 shrink-0" />
                    Copy URL
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive-foreground"
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          ) : (
            // Its items act on the App, so the menu opens once the App is here.
            <Button variant="ghost" size="icon" aria-label="More actions" disabled>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

      {a && idle ? (
        <Alert className={cn(phaseChanged && ENTER)}>
          <Moon aria-hidden="true" />
          <AlertTitle>Idle</AlertTitle>
          <AlertDescription>
            Scaled to zero after going its idle timeout without a request.
            {a.status.lastActivityTime ? (
              <> Last request {relativeTime(a.status.lastActivityTime)}.</>
            ) : null}{" "}
            Opening the app or Wake starts it again; the first visit waits while it starts.
          </AlertDescription>
        </Alert>
      ) : null}

      {failure ? (
        <Alert
          variant="destructive"
          role="alert"
          className={cn("has-data-[slot=alert-action]:pr-2", phaseChanged && ENTER)}
        >
          <AlertCircle aria-hidden="true" />
          <AlertTitle>{failure.title}</AlertTitle>
          {failure.message ? <AlertDescription>{failure.message}</AlertDescription> : null}
          <AlertAction className="static col-start-2 mt-2 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => selectTab("logs")}>
              <ScrollText aria-hidden="true" /> View logs
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={stopped}
              loading={restart.isPending}
              onClick={() => a && restart.mutate(a)}
            >
              <RotateCw aria-hidden="true" /> Restart
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <div
        className={
          showUsage
            ? "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            : "grid grid-cols-1 gap-4 sm:grid-cols-2"
        }
      >
        <Card>
          <CardHeader>
            <CardTitle>URL</CardTitle>
          </CardHeader>
          <CardContent>
            {!a ? (
              <div aria-hidden="true">
                <TextLine className="w-4/5" />
                <TextLine box="h-4" className="mt-2 h-3 w-3/4" />
                <TextLine box="h-4" className="mt-1 h-3 w-1/2" />
              </div>
            ) : (
              <div className={cn(reveal)}>
                {a.status.url ? (
                  ready ? (
                    <a
                      className="break-all font-mono text-sm underline"
                      href={a.status.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {a.status.url}
                    </a>
                  ) : (
                    <p
                      className="break-all font-mono text-muted-foreground text-sm"
                      title="App is not running"
                    >
                      {a.status.url}
                    </p>
                  )
                ) : (
                  <p className="text-muted-foreground text-sm">Not routed yet</p>
                )}
                <p className="mt-2 text-muted-foreground text-xs">{accessLine(a)}</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {a.landingPage?.enabled === true
                    ? "Shown on the landing page"
                    : a.landingPage?.enabled === false
                      ? "Hidden from the landing page"
                      : "Landing page: cluster default"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Replicas</CardTitle>
          </CardHeader>
          <CardContent>
            {!a ? (
              <div aria-hidden="true">
                <TextLine box="h-8" className="h-6 w-20" />
                <TextLine box="h-4" className="mt-1 h-3 w-3/4" />
              </div>
            ) : (
              <div className={cn(reveal)}>
                <p className="font-semibold text-2xl tabular-nums">
                  {a.status.replicas ? (
                    <>
                      {a.status.replicas.ready}
                      <span className="ml-1 font-normal text-muted-foreground text-sm">
                        of {a.status.replicas.desired} ready
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">{a.status.message}</p>
              </div>
            )}
          </CardContent>
        </Card>
        {showUsage ? (
          <>
            <RestartsCard
              health={health}
              loading={metrics.isLoading || !a}
              reveal={metricsArrived ? FADE_IN : undefined}
            />
            <ResourcesCard
              health={health}
              loading={metrics.isLoading || !a}
              reveal={metricsArrived ? FADE_IN : undefined}
              usageAvailable={sample?.available ?? false}
              cpuHistory={cpuHistory}
              memHistory={memHistory}
            />
          </>
        ) : null}
      </div>
      {showUsage ? null : (
        <p className="text-muted-foreground text-sm">
          Restarts and resources are shown once the app is running.
        </p>
      )}

      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (isDetailTab(next)) selectTab(next);
        }}
      >
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTab value="conditions">Health</TabsTab>
          <TabsTab value="logs">Logs</TabsTab>
          <TabsTab value="events">Events</TabsTab>
          <TabsTab value="manifest">Manifest</TabsTab>
        </TabsList>

        <TabsPanel value="conditions" className={cn("mt-4", tabChanged && FADE_IN)}>
          <Card>
            <CardContent className="p-4">
              {!a ? (
                <ListSkeleton />
              ) : (
                <ul className={cn("space-y-3", reveal)}>
                  {a.status.conditions.map((c) => (
                    <li key={c.type} className="flex items-start gap-2">
                      {c.status === "True" ? (
                        <CheckCircle2
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-success-foreground"
                        />
                      ) : (
                        <XCircle
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
                        />
                      )}
                      <div>
                        <p className="font-medium text-sm">
                          <span className="sr-only">
                            {c.status === "True" ? "Passing: " : "Failing: "}
                          </span>
                          {c.type} <span className="text-muted-foreground">· {c.reason}</span>
                        </p>
                        <p className="text-muted-foreground text-sm">{c.message}</p>
                      </div>
                    </li>
                  ))}
                  {a.status.conditions.length === 0 ? (
                    <p className="text-muted-foreground text-sm">No conditions reported yet.</p>
                  ) : null}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="logs" className={cn("mt-4", tabChanged && FADE_IN)}>
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle>Pod logs</CardTitle>
              <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
                <Input
                  aria-label="Filter log lines"
                  placeholder="Filter lines…"
                  className="h-8 w-full sm:w-48"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                />
                <label
                  htmlFor="log-follow"
                  className="flex items-center gap-2 text-muted-foreground text-sm"
                >
                  <Switch id="log-follow" checked={logFollow} onCheckedChange={setLogFollow} />{" "}
                  Follow
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh logs"
                  onClick={() => void logs.refetch()}
                >
                  <RefreshCw className={logs.isFetching ? "motion-safe:animate-spin" : ""} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Download logs"
                  onClick={downloadLogs}
                >
                  <Download />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {logs.isLoading ? (
                <LogSkeleton />
              ) : logs.isError && !filteredLogs ? (
                <div className="rounded-md bg-muted p-3 text-sm">
                  <p>No logs available</p>
                  <p className="mt-1 text-muted-foreground">{errorMessage(logs.error)}</p>
                </div>
              ) : (
                <pre
                  role="log"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls, so keyboard users need to reach it
                  tabIndex={0}
                  aria-label="Pod logs"
                  className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed"
                >
                  {filteredLogs || (logSearch ? "No matching lines." : "No log lines yet.")}
                </pre>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="events" className={cn("mt-4", tabChanged && FADE_IN)}>
          <Card>
            <CardContent className="p-4">
              {events.isLoading ? (
                <ListSkeleton label="Loading events" />
              ) : (
                <ul className="space-y-2">
                  {(events.data ?? []).map((ev, i) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: events have no stable id and the list is replaced on every poll
                      key={`${ev.object}-${ev.reason}-${i}`}
                      className="flex items-start justify-between gap-3 border-border border-b pb-2 text-sm last:border-0"
                    >
                      <div>
                        <p className="font-medium">
                          {ev.reason}{" "}
                          <span className="font-normal text-muted-foreground">
                            · {ev.kind}/{ev.object}
                          </span>
                        </p>
                        <p className="text-muted-foreground">{ev.message}</p>
                      </div>
                      {ev.lastTimestamp ? (
                        <time
                          dateTime={ev.lastTimestamp}
                          title={ev.lastTimestamp}
                          className="shrink-0 text-muted-foreground text-xs"
                        >
                          {relativeTime(ev.lastTimestamp)}
                        </time>
                      ) : null}
                    </li>
                  ))}
                  {(events.data ?? []).length === 0 ? (
                    <p className="text-muted-foreground text-sm">No events.</p>
                  ) : null}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="manifest" className={cn("mt-4", tabChanged && FADE_IN)}>
          <Card>
            <CardHeader>
              <CardTitle>App resource</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-muted-foreground text-sm">
                The App custom resource for this app. Copy it into a GitOps repo, or apply with{" "}
                <span className="font-mono">kubectl apply -f</span>.
              </p>
              {a ? (
                <CodeBlock code={toManifest(a)} className={cn(reveal)}>
                  <CodeBlockBody maxLines={24} />
                </CodeBlock>
              ) : (
                <Skeleton shape="block" className="h-64" />
              )}
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>

      {a ? (
        <ConfirmDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          appName={a.name}
          displayName={a.displayName}
          loading={remove.isPending}
          onConfirm={() => remove.mutate(a)}
        />
      ) : null}
    </div>
  );
}

function filterLogs(logs: string, term: string): string {
  const t = term.trim().toLowerCase();
  if (!t) return logs;
  return logs
    .split("\n")
    .filter((line) => line.toLowerCase().includes(t))
    .join("\n");
}

/**
 * Why the app is unhealthy, for the Alert under the header: the first
 * condition that is not True, named with its reason, or the phase message
 * for a Failed app with no failing condition. Conditions still settling on
 * a Pending or Deploying app are not failures yet.
 */
function failureOf(a: App): { title: string; message: string } | null {
  const { phase, conditions, message } = a.status;
  if (phase !== "Failed" && phase !== "Running") return null;
  const failing = conditions.find((c) => c.status !== "True");
  if (failing) {
    return {
      title: `${failing.type} failed: ${failing.reason || "Unknown"}`,
      message: failing.message || message,
    };
  }
  if (phase === "Failed") return { title: "App failed", message };
  return null;
}

/** Rebuild the App custom resource from API data, as YAML for `kubectl apply -f`. */
function toManifest(a: App): string {
  const spec: Record<string, unknown> = { displayName: a.displayName };
  if (a.description) spec.description = a.description;
  if (a.thumbnail) spec.thumbnail = a.thumbnail;
  if (a.source) spec.source = a.source;
  if (a.runtime) spec.runtime = a.runtime;
  if (a.access) spec.access = a.access;
  if (a.landingPage) spec.landingPage = a.landingPage;
  const cr = {
    apiVersion: "apps.nebari.dev/v1alpha1",
    kind: "App",
    metadata: { name: a.name, namespace: a.namespace },
    spec,
  };
  return toYaml(cr);
}
