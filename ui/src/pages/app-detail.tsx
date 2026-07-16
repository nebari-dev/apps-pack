import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PhaseBadge, SourceBadge } from '@/components/app-bits';
import { api } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/ui/dialog';
import { Spinner } from '@/ui/spinner';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/ui/tabs';

export function AppDetailPage() {
  const { namespace = '', name = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState('');

  const app = useQuery({
    queryKey: ['app', namespace, name],
    queryFn: () => api.getApp(namespace, name),
    refetchInterval: 5_000,
  });
  const logs = useQuery({
    queryKey: ['logs', namespace, name],
    queryFn: () => api.logs(namespace, name, 500),
    refetchInterval: 10_000,
    retry: false,
  });
  const events = useQuery({
    queryKey: ['events', namespace, name],
    queryFn: () => api.events(namespace, name),
    refetchInterval: 15_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['app', namespace, name] });
    void queryClient.invalidateQueries({ queryKey: ['apps'] });
    void queryClient.invalidateQueries({ queryKey: ['analytics'] });
  };
  const onError = (err: unknown) => setActionError(err instanceof Error ? err.message : String(err));

  const stop = useMutation({ mutationFn: () => api.stopApp(namespace, name), onSuccess: invalidate, onError });
  const start = useMutation({ mutationFn: () => api.startApp(namespace, name), onSuccess: invalidate, onError });
  const remove = useMutation({
    mutationFn: () => api.deleteApp(namespace, name),
    onSuccess: () => {
      invalidate();
      void navigate('/apps');
    },
    onError,
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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/apps"
            className="mb-1 inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> Apps
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-semibold text-2xl">{a.displayName || a.name}</h1>
            <SourceBadge source={a.source?.type ?? '—'} />
            <PhaseBadge phase={a.status.phase} />
          </div>
          <p className="mt-1 text-muted-foreground text-sm">
            {a.namespace}/{a.name}
            {a.owner ? <> · launched by {a.owner}</> : null}
            {a.description ? <> · {a.description}</> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {a.status.url ? (
            <Button
              variant="outline"
              render={
                <a href={a.status.url} target="_blank" rel="noreferrer">
                  Open <ExternalLink />
                </a>
              }
            />
          ) : null}
          {stopped ? (
            <Button variant="secondary" loading={start.isPending} onClick={() => start.mutate()}>
              <Play /> Start
            </Button>
          ) : (
            <Button variant="secondary" loading={stop.isPending} onClick={() => stop.mutate()}>
              <Pause /> Stop
            </Button>
          )}
          <Dialog>
            <DialogTrigger
              render={
                <Button variant="destructive">
                  <Trash2 /> Delete
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete {a.displayName || a.name}?</DialogTitle>
                <DialogDescription>
                  This removes the app, its routing, TLS certificate, and OIDC client. It cannot
                  be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button variant="destructive" loading={remove.isPending} onClick={() => remove.mutate()}>
                  Delete app
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {actionError ? (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
            <CardTitle>Source</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              <span className="text-muted-foreground">type:</span>{' '}
              <span className="font-mono">{a.source?.type ?? '—'}</span>
            </p>
            {a.source?.git ? (
              <p className="break-all">
                <span className="text-muted-foreground">git:</span>{' '}
                <span className="font-mono">{a.source.git.url}@{a.source.git.ref ?? 'main'}</span>
              </p>
            ) : null}
            {a.source?.pvc ? (
              <p className="break-all">
                <span className="text-muted-foreground">pvc:</span>{' '}
                <span className="font-mono">
                  {a.source.pvc.claimName}
                  {a.source.pvc.subPath ? `/${a.source.pvc.subPath}` : ''}
                </span>
              </p>
            ) : null}
            {a.source?.inline ? (
              <p>
                <span className="text-muted-foreground">inline files:</span>{' '}
                {Object.keys(a.source.inline.files).length}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="conditions">
        <TabsList>
          <TabsTab value="conditions">Conditions</TabsTab>
          <TabsTab value="logs">Logs</TabsTab>
          <TabsTab value="events">Events</TabsTab>
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
                {a.status.conditions.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No conditions reported yet.</p>
                ) : null}
              </ul>
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="logs" className="mt-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Pod logs</CardTitle>
              <Button variant="ghost" size="icon-sm" onClick={() => void logs.refetch()}>
                <RefreshCw className={logs.isFetching ? 'animate-spin' : ''} />
              </Button>
            </CardHeader>
            <CardContent>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                {logs.data?.logs || (logs.isError ? `No logs available: ${logs.error}` : 'Loading…')}
              </pre>
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="events" className="mt-4">
          <Card>
            <CardContent className="p-4">
              <ul className="space-y-2">
                {(events.data ?? []).map((ev, i) => (
                  <li
                    key={`${ev.object}-${ev.reason}-${i}`}
                    className="flex items-start justify-between gap-3 border-border border-b pb-2 text-sm last:border-0"
                  >
                    <div>
                      <p className="font-medium">
                        {ev.reason}{' '}
                        <span className="font-normal text-muted-foreground">
                          · {ev.kind}/{ev.object}
                        </span>
                      </p>
                      <p className="text-muted-foreground">{ev.message}</p>
                    </div>
                    <span className="shrink-0 text-muted-foreground text-xs">{ev.lastTimestamp}</span>
                  </li>
                ))}
                {(events.data ?? []).length === 0 ? (
                  <p className="text-muted-foreground text-sm">No events.</p>
                ) : null}
              </ul>
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
