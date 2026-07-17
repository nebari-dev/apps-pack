import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppThumbnail, ConfirmDeleteDialog, KindBadge, metricValue, PhaseBadge, Sparkline, SourceBadge } from '@/components/app-bits';
import { api } from '@/lib/api';
import type { App } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { CodeBlock, CodeBlockBody } from '@/ui/code-block';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { Switch } from '@/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/ui/tabs';
import { toast } from '@/ui/toast';

const MAX_SAMPLES = 30;
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AppDetailPage() {
  const { namespace = '', name = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [logFollow, setLogFollow] = useState(true);
  const [logSearch, setLogSearch] = useState('');
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);

  const app = useQuery({
    queryKey: ['app', namespace, name],
    queryFn: () => api.getApp(namespace, name),
    refetchInterval: 5_000,
  });
  const logs = useQuery({
    queryKey: ['logs', namespace, name],
    queryFn: () => api.logs(namespace, name, 500),
    refetchInterval: logFollow ? 3_000 : false,
    retry: false,
  });
  const events = useQuery({
    queryKey: ['events', namespace, name],
    queryFn: () => api.events(namespace, name),
    refetchInterval: 15_000,
  });
  const metrics = useQuery({
    queryKey: ['metrics', namespace, name],
    queryFn: () => api.metrics(namespace, name),
    refetchInterval: 5_000,
    retry: false,
  });

  // Roll instantaneous metrics into a short client-side history for the sparkline.
  const sample = metrics.data;
  useEffect(() => {
    if (!sample?.available) return;
    const cpu = sample.pods.reduce((sum, p) => sum + metricValue(p.cpu), 0);
    const mem = sample.pods.reduce((sum, p) => sum + metricValue(p.memory), 0);
    setCpuHistory((h) => [...h, cpu].slice(-MAX_SAMPLES));
    setMemHistory((h) => [...h, mem].slice(-MAX_SAMPLES));
  }, [sample]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['app', namespace, name] });
    void queryClient.invalidateQueries({ queryKey: ['apps'] });
    void queryClient.invalidateQueries({ queryKey: ['analytics'] });
  };
  const label = () => app.data?.displayName || name;

  const stop = useMutation({
    mutationFn: () => api.stopApp(namespace, name),
    onSuccess: () => {
      invalidate();
      toast.success(`Stopped ${label()}`);
    },
    onError: (err) => toast.error(`Failed to stop ${label()}`, errMessage(err)),
  });
  const start = useMutation({
    mutationFn: () => api.startApp(namespace, name),
    onSuccess: () => {
      invalidate();
      toast.success(`Started ${label()}`);
    },
    onError: (err) => toast.error(`Failed to start ${label()}`, errMessage(err)),
  });
  const restart = useMutation({
    mutationFn: () => api.restartApp(namespace, name),
    onSuccess: () => {
      invalidate();
      toast.success(`Restarting ${label()}`, 'Pods are rolling now.');
    },
    onError: (err) => toast.error(`Failed to restart ${label()}`, errMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteApp(namespace, name),
    onSuccess: () => {
      invalidate();
      toast.success(`Deleted ${label()}`);
      void navigate('/apps');
    },
    onError: (err) => toast.error(`Failed to delete ${label()}`, errMessage(err)),
  });

  if (app.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (app.isError || !app.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load app</AlertTitle>
        <AlertDescription>{String(app.error ?? 'not found')}</AlertDescription>
      </Alert>
    );
  }

  const a = app.data;
  const stopped = (a.status.replicas?.desired ?? a.runtime?.replicas ?? 1) === 0;
  const manifest = toManifest(a);

  const filteredLogs = filterLogs(logs.data?.logs ?? '', logSearch);
  const downloadLogs = () => {
    const blob = new Blob([logs.data?.logs ?? ''], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}-logs.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-4">
          <AppThumbnail name={a.name} displayName={a.displayName} thumbnail={a.thumbnail} className="mt-6 size-12" />
          <div className="min-w-0">
            <Link to="/apps" className="mb-1 inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
              <ArrowLeft className="size-3.5" /> Apps
            </Link>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-semibold text-2xl">{a.displayName || a.name}</h1>
              <SourceBadge source={a.source?.type ?? '—'} />
              <KindBadge pixiTask={a.runtime?.pixiTask} />
              <PhaseBadge phase={a.status.phase} />
            </div>
            <p className="mt-1 text-muted-foreground text-sm">
              {a.namespace}/{a.name}
              {a.owner ? <> · launched by {a.owner}</> : null}
              {a.description ? <> · {a.description}</> : null}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {a.status.url ? (
            <Button variant="outline" render={<a href={a.status.url} target="_blank" rel="noreferrer">Open <ExternalLink /></a>} />
          ) : null}
          <Button variant="outline" render={<Link to={`/apps/${namespace}/${name}/edit`}>Edit <Pencil /></Link>} />
          {stopped ? (
            <Button variant="secondary" loading={start.isPending} onClick={() => start.mutate()}>
              <Play /> Start
            </Button>
          ) : (
            <Button variant="secondary" loading={stop.isPending} onClick={() => stop.mutate()}>
              <Pause /> Stop
            </Button>
          )}
          <Button variant="secondary" disabled={stopped} loading={restart.isPending} onClick={() => restart.mutate()}>
            <RotateCw /> Restart
          </Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>URL</CardTitle>
          </CardHeader>
          <CardContent>
            {a.status.url ? (
              <a className="break-all font-mono text-sm underline" href={a.status.url} target="_blank" rel="noreferrer">
                {a.status.url}
              </a>
            ) : (
              <p className="text-muted-foreground text-sm">Not routed yet</p>
            )}
            <p className="mt-2 text-muted-foreground text-xs">
              {a.access?.public
                ? 'Public - no authentication'
                : `Keycloak SSO at the gateway${a.access?.groups?.length ? ` · groups: ${a.access.groups.join(', ')}` : ''}`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Replicas</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-semibold text-2xl tabular-nums">
              {a.status.replicas ? `${a.status.replicas.ready}/${a.status.replicas.desired}` : '—'}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">{a.status.message}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>CPU</CardTitle>
          </CardHeader>
          <CardContent>
            {metrics.data?.available ? (
              <>
                <p className="font-semibold text-2xl tabular-nums">
                  {cpuHistory.at(-1) ?? 0}
                  <span className="ml-1 font-normal text-muted-foreground text-sm">m</span>
                </p>
                <Sparkline data={cpuHistory} className="mt-2 w-full" />
              </>
            ) : (
              <p className="text-muted-foreground text-sm">Metrics unavailable</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Memory</CardTitle>
          </CardHeader>
          <CardContent>
            {metrics.data?.available ? (
              <>
                <p className="font-semibold text-2xl tabular-nums">
                  {memHistory.at(-1) ?? 0}
                  <span className="ml-1 font-normal text-muted-foreground text-sm">Mi</span>
                </p>
                <Sparkline data={memHistory} className="mt-2 w-full" />
              </>
            ) : (
              <p className="text-muted-foreground text-sm">Metrics unavailable</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="conditions">
        <TabsList>
          <TabsTab value="conditions">Conditions</TabsTab>
          <TabsTab value="logs">Logs</TabsTab>
          <TabsTab value="events">Events</TabsTab>
          <TabsTab value="manifest">Manifest</TabsTab>
        </TabsList>

        <TabsPanel value="conditions" className="mt-4">
          <Card>
            <CardContent className="p-4">
              <ul className="space-y-3">
                {a.status.conditions.map((c) => (
                  <li key={c.type} className="flex items-start gap-2">
                    {c.status === 'True' ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-foreground" />
                    ) : (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
                    )}
                    <div>
                      <p className="font-medium text-sm">
                        {c.type} <span className="text-muted-foreground">· {c.reason}</span>
                      </p>
                      <p className="text-muted-foreground text-sm">{c.message}</p>
                    </div>
                  </li>
                ))}
                {a.status.conditions.length === 0 ? <p className="text-muted-foreground text-sm">No conditions reported yet.</p> : null}
              </ul>
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="logs" className="mt-4">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle>Pod logs</CardTitle>
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Filter lines…"
                  className="h-8 w-48"
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                />
                <label htmlFor="log-follow" className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Switch id="log-follow" checked={logFollow} onCheckedChange={setLogFollow} /> Follow
                </label>
                <Button variant="ghost" size="icon-sm" aria-label="Refresh logs" onClick={() => void logs.refetch()}>
                  <RefreshCw className={logs.isFetching ? 'animate-spin' : ''} />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Download logs" onClick={downloadLogs}>
                  <Download />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                {filteredLogs || (logs.isError ? `No logs available: ${logs.error}` : logSearch ? 'No matching lines.' : 'Loading…')}
              </pre>
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="events" className="mt-4">
          <Card>
            <CardContent className="p-4">
              <ul className="space-y-2">
                {(events.data ?? []).map((ev, i) => (
                  <li key={`${ev.object}-${ev.reason}-${i}`} className="flex items-start justify-between gap-3 border-border border-b pb-2 text-sm last:border-0">
                    <div>
                      <p className="font-medium">
                        {ev.reason} <span className="font-normal text-muted-foreground">· {ev.kind}/{ev.object}</span>
                      </p>
                      <p className="text-muted-foreground">{ev.message}</p>
                    </div>
                    <span className="shrink-0 text-muted-foreground text-xs">{ev.lastTimestamp}</span>
                  </li>
                ))}
                {(events.data ?? []).length === 0 ? <p className="text-muted-foreground text-sm">No events.</p> : null}
              </ul>
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="manifest" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>App resource</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-muted-foreground text-sm">
                The App custom resource for this app. Copy it into a GitOps repo, or apply with{' '}
                <span className="font-mono">kubectl apply -f</span>.
              </p>
              <CodeBlock code={manifest}>
                <CodeBlockBody maxLines={24} />
              </CodeBlock>
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        appName={a.name}
        displayName={a.displayName}
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function filterLogs(logs: string, term: string): string {
  const t = term.trim().toLowerCase();
  if (!t) return logs;
  return logs
    .split('\n')
    .filter((line) => line.toLowerCase().includes(t))
    .join('\n');
}

/** Rebuild the App custom resource from API data, as pretty JSON. */
function toManifest(a: App): string {
  const spec: Record<string, unknown> = { displayName: a.displayName };
  if (a.description) spec.description = a.description;
  if (a.thumbnail) spec.thumbnail = a.thumbnail;
  if (a.source) spec.source = a.source;
  if (a.runtime) spec.runtime = a.runtime;
  if (a.access) spec.access = a.access;
  const cr = {
    apiVersion: 'apps.nebari.dev/v1alpha1',
    kind: 'App',
    metadata: { name: a.name, namespace: a.namespace },
    spec,
  };
  return JSON.stringify(cr, null, 2);
}
