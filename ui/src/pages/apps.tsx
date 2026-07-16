import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PhaseBadge, SourceBadge } from '@/components/app-bits';
import { api } from '@/lib/api';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/table';

export function AppsPage() {
  const apps = useQuery({ queryKey: ['apps'], queryFn: () => api.listApps() });
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const list = apps.data ?? [];
    const term = filter.trim().toLowerCase();
    if (!term) return list;
    return list.filter((a) =>
      [a.name, a.displayName, a.namespace, a.source?.type ?? '', a.owner, a.status.phase]
        .join(' ')
        .toLowerCase()
        .includes(term),
    );
  }, [apps.data, filter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold text-2xl">Apps</h1>
          <p className="text-muted-foreground text-sm">
            Everything launched through the Apps Pack, across your namespaces.
          </p>
        </div>
        <Button render={<Link to="/launch">Launch app</Link>} />
      </div>

      <div className="relative max-w-sm">
        <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
        <Input
          placeholder="Filter by name, source, status…"
          className="pl-8"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {apps.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-sm">
          {filter ? 'No apps match your filter.' : 'No apps yet - launch your first one.'}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Namespace</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Replicas</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="text-right">URL</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((app) => (
              <TableRow key={`${app.namespace}/${app.name}`}>
                <TableCell>
                  <Link
                    to={`/apps/${app.namespace}/${app.name}`}
                    className="font-medium hover:underline"
                  >
                    {app.displayName || app.name}
                  </Link>
                  <p className="text-muted-foreground text-xs">{app.name}</p>
                </TableCell>
                <TableCell className="text-muted-foreground">{app.namespace}</TableCell>
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
                  {app.status.url && app.status.phase === 'Running' ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      render={
                        // biome-ignore lint/a11y/useAnchorContent: icon child
                        <a href={app.status.url} target="_blank" rel="noreferrer" />
                      }
                    >
                      <ExternalLink />
                    </Button>
                  ) : (
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
