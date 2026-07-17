import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ExternalLink,
  Eye,
  Pause,
  Pencil,
  Play,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppThumbnail, ConfirmDeleteDialog, PhaseBadge, SourceBadge } from '@/components/app-bits';
import { Onboarding } from '@/components/onboarding';
import { api } from '@/lib/api';
import type { App } from '@/lib/types';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { toast } from '@/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { cn } from '@/lib/utils';

const appLabel = (app: App) => app.displayName || app.name;
const appKey = (app: App) => `${app.namespace}/${app.name}`;
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isStopped = (app: App) => (app.status.replicas?.desired ?? app.runtime?.replicas ?? 1) === 0;

const PHASES = ['Running', 'Deploying', 'Pending', 'Stopped', 'Failed'] as const;

type SortCol = 'name' | 'namespace' | 'type' | 'source' | 'status' | 'owner';

/** App kind shown in the Type column: pixi-launched apps are python, the rest static. */
const appType = (app: App) => (app.runtime?.pixiTask ? 'python' : 'static');
type SortDir = 'asc' | 'desc';

export function AppsPage() {
  const queryClient = useQueryClient();
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api.listApps() });
  const [filter, setFilter] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<{ col: SortCol; dir: SortDir }>({ col: 'name', dir: 'asc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState('');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['apps'] });
    void queryClient.invalidateQueries({ queryKey: ['analytics'] });
  };

  const stop = useMutation({
    mutationFn: (app: App) => api.stopApp(app.namespace, app.name),
    onSuccess: (_d, app) => {
      invalidate();
      toast.success(`Stopped ${appLabel(app)}`);
    },
    onError: (err, app) => toast.error(`Failed to stop ${appLabel(app)}`, errMessage(err)),
  });
  const start = useMutation({
    mutationFn: (app: App) => api.startApp(app.namespace, app.name),
    onSuccess: (_d, app) => {
      invalidate();
      toast.success(`Started ${appLabel(app)}`);
    },
    onError: (err, app) => toast.error(`Failed to start ${appLabel(app)}`, errMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (app: App) => api.deleteApp(app.namespace, app.name),
    onSuccess: (_d, app) => {
      invalidate();
      setDeleteTarget(null);
      toast.success(`Deleted ${appLabel(app)}`);
    },
    onError: (err, app) => toast.error(`Failed to delete ${appLabel(app)}`, errMessage(err)),
  });

  const list = apps.data ?? [];
  const phaseCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of list) counts[a.status.phase] = (counts[a.status.phase] ?? 0) + 1;
    return counts;
  }, [list]);

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase();
    let out = list.filter((a) => {
      if (phaseFilter && a.status.phase !== phaseFilter) return false;
      if (!term) return true;
      return [a.name, a.displayName, a.namespace, appType(a), a.source?.type ?? '', a.owner, a.status.phase]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
    const val = (a: App): string => {
      switch (sort.col) {
        case 'namespace':
          return a.namespace;
        case 'type':
          return appType(a);
        case 'source':
          return a.source?.type ?? '';
        case 'status':
          return a.status.phase;
        case 'owner':
          return a.owner ?? '';
        default:
          return (a.displayName || a.name).toLowerCase();
      }
    };
    out = [...out].sort((a, b) => val(a).localeCompare(val(b)) * (sort.dir === 'asc' ? 1 : -1));
    return out;
  }, [list, filter, phaseFilter, sort]);

  const selectedApps = useMemo(() => rows.filter((a) => selected.has(appKey(a))), [rows, selected]);
  const allSelected = rows.length > 0 && rows.every((a) => selected.has(appKey(a)));
  const someSelected = selectedApps.length > 0 && !allSelected;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rows.map(appKey)));
  };
  const toggleOne = (app: App) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const key = appKey(app);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const bulkAction = useMutation({
    mutationFn: async (action: 'start' | 'stop' | 'delete') => {
      const targets = selectedApps;
      await Promise.all(
        targets.map((a) =>
          action === 'start'
            ? api.startApp(a.namespace, a.name)
            : action === 'stop'
              ? api.stopApp(a.namespace, a.name)
              : api.deleteApp(a.namespace, a.name),
        ),
      );
      return action;
    },
    onSuccess: (action) => {
      invalidate();
      setBulkDeleteOpen(false);
      setBulkConfirm('');
      setSelected(new Set());
      toast.success(`${action === 'delete' ? 'Deleted' : action === 'stop' ? 'Stopped' : 'Started'} ${selectedApps.length} app(s)`);
    },
    onError: (err) => toast.error('Bulk action failed', errMessage(err)),
  });

  const toggleSort = (col: SortCol) =>
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));

  const isPendingFor = (m: { isPending: boolean; variables?: App }, app: App) =>
    m.isPending && m.variables?.namespace === app.namespace && m.variables?.name === app.name;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold text-2xl">Apps</h1>
          <p className="text-muted-foreground text-sm">Everything launched through the Apps Pack, across your namespaces.</p>
        </div>
        <Button render={<Link to="/launch">Launch app</Link>} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 z-10 size-4 text-muted-foreground" />
          <Input placeholder="Search by name, source, status…" className="pr-9 pl-9" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter ? (
            <button
              type="button"
              aria-label="Clear search"
              className="-translate-y-1/2 absolute top-1/2 right-2 z-10 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip label="All" count={list.length} active={phaseFilter === null} onClick={() => setPhaseFilter(null)} />
          {PHASES.filter((p) => phaseCounts[p]).map((p) => (
            <FilterChip key={p} label={p} count={phaseCounts[p]} active={phaseFilter === p} onClick={() => setPhaseFilter(p)} />
          ))}
        </div>
      </div>

      {selectedApps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
          <span className="font-medium text-sm">{selectedApps.length} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" loading={bulkAction.isPending && bulkAction.variables === 'start'} onClick={() => bulkAction.mutate('start')}>
              <Play /> Start
            </Button>
            <Button variant="outline" size="sm" loading={bulkAction.isPending && bulkAction.variables === 'stop'} onClick={() => bulkAction.mutate('stop')}>
              <Pause /> Stop
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setBulkDeleteOpen(true)}>
              <Trash2 /> Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      {apps.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : list.length === 0 ? (
        <Onboarding />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-sm">No apps match your filter.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox aria-label="Select all" checked={allSelected} indeterminate={someSelected} onCheckedChange={toggleAll} />
              </TableHead>
              <SortableHead label="App" col="name" sort={sort} onToggle={toggleSort} />
              <SortableHead label="Namespace" col="namespace" sort={sort} onToggle={toggleSort} />
              <SortableHead label="Type" col="type" sort={sort} onToggle={toggleSort} />
              <SortableHead label="Source" col="source" sort={sort} onToggle={toggleSort} />
              <SortableHead label="Status" col="status" sort={sort} onToggle={toggleSort} />
              <TableHead>Replicas</TableHead>
              <SortableHead label="Owner" col="owner" sort={sort} onToggle={toggleSort} />
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((app) => {
              const stopped = isStopped(app);
              const checked = selected.has(appKey(app));
              return (
                <TableRow key={appKey(app)} data-selected={checked || undefined}>
                  <TableCell>
                    <Checkbox aria-label={`Select ${appLabel(app)}`} checked={checked} onCheckedChange={() => toggleOne(app)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <AppThumbnail name={app.name} displayName={app.displayName} thumbnail={app.thumbnail} className="size-9" />
                      <div className="min-w-0">
                        <Link to={`/apps/${app.namespace}/${app.name}`} className="font-medium hover:underline">
                          {app.displayName || app.name}
                        </Link>
                        <p className="text-muted-foreground text-xs">{app.name}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{app.namespace}</TableCell>
                  <TableCell>
                    <SourceBadge source={appType(app)} />
                  </TableCell>
                  <TableCell>
                    <SourceBadge source={app.source?.type ?? '—'} />
                  </TableCell>
                  <TableCell>
                    <PhaseBadge phase={app.status.phase} />
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {app.status.replicas ? `${app.status.replicas.ready}/${app.status.replicas.desired}` : '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{app.owner || '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <IconLink to={`/apps/${app.namespace}/${app.name}`} label="View">
                        <Eye />
                      </IconLink>
                      <IconLink to={`/apps/${app.namespace}/${app.name}/edit`} label="Edit">
                        <Pencil />
                      </IconLink>
                      {app.status.url && app.status.phase === 'Running' ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                render={
                                  // biome-ignore lint/a11y/useAnchorContent: icon child
                                  <a href={app.status.url} target="_blank" rel="noreferrer" aria-label="Open app" />
                                }
                              >
                                <ExternalLink />
                              </Button>
                            }
                          />
                          <TooltipContent>Open</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {stopped ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button variant="ghost" size="icon-sm" aria-label="Start app" loading={isPendingFor(start, app)} onClick={() => start.mutate(app)}>
                                <Play />
                              </Button>
                            }
                          />
                          <TooltipContent>Start</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button variant="ghost" size="icon-sm" aria-label="Stop app" loading={isPendingFor(stop, app)} onClick={() => stop.mutate(app)}>
                                <Pause />
                              </Button>
                            }
                          />
                          <TooltipContent>Stop</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete app"
                              className="text-destructive-foreground hover:bg-destructive hover:text-destructive-foreground"
                              onClick={() => setDeleteTarget(app)}
                            >
                              <Trash2 />
                            </Button>
                          }
                        />
                        <TooltipContent>Delete</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        appName={deleteTarget?.name ?? ''}
        displayName={deleteTarget?.displayName}
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />

      <Dialog open={bulkDeleteOpen} onOpenChange={(open) => { if (!open) setBulkConfirm(''); setBulkDeleteOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedApps.length} apps?</DialogTitle>
            <DialogDescription>
              This removes each app, its routing, TLS certificate, and OIDC client. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-sm">
              Type <span className="font-mono font-semibold text-foreground">delete</span> to confirm.
            </p>
            <Input autoComplete="off" value={bulkConfirm} onChange={(e) => setBulkConfirm(e.target.value)} />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button variant="destructive" disabled={bulkConfirm.trim() !== 'delete'} loading={bulkAction.isPending} onClick={() => bulkAction.mutate('delete')}>
              Delete {selectedApps.length} apps
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium text-xs transition-colors',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function SortableHead({
  label,
  col,
  sort,
  onToggle,
}: {
  label: string;
  col: SortCol;
  sort: { col: SortCol; dir: SortDir };
  onToggle: (c: SortCol) => void;
}) {
  const active = sort.col === col;
  return (
    <TableHead>
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => onToggle(col)}>
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )
        ) : (
          <ChevronsUpDown className="size-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

function IconLink({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            render={
              // biome-ignore lint/a11y/useAnchorContent: icon child
              <Link to={to} aria-label={label} />
            }
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
