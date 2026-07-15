import { CheckCircle2, CircleDashed, Loader2, PauseCircle, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/ui/badge';
import { Card, CardContent } from '@/ui/card';
import { cn } from '@/lib/utils';

export function PhaseBadge({ phase }: { phase: string }) {
  const map: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: ReactNode; className?: string }> = {
    Running: {
      variant: 'outline',
      icon: <CheckCircle2 className="size-3.5 text-success-foreground" />,
      className: 'border-success-border bg-success text-success-foreground',
    },
    Failed: { variant: 'destructive', icon: <XCircle className="size-3.5" /> },
    Stopped: { variant: 'secondary', icon: <PauseCircle className="size-3.5" /> },
    Deploying: { variant: 'outline', icon: <Loader2 className="size-3.5 animate-spin" /> },
    Pending: { variant: 'outline', icon: <CircleDashed className="size-3.5" /> },
  };
  const cfg = map[phase] ?? map.Pending;
  return (
    <Badge variant={cfg.variant} className={cn('gap-1', cfg.className)}>
      {cfg.icon}
      {phase || 'Pending'}
    </Badge>
  );
}

export function FrameworkBadge({ framework }: { framework: string }) {
  return <Badge variant="ghost" className="border border-border font-mono text-xs">{framework}</Badge>;
}

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-2 p-4">
        <div>
          <p className="text-muted-foreground text-sm">{label}</p>
          <p className="mt-1 font-semibold text-2xl tabular-nums">{value}</p>
          {hint ? <p className="mt-1 text-muted-foreground text-xs">{hint}</p> : null}
        </div>
        {icon ? <div className="rounded-md bg-accent p-2 text-accent-foreground">{icon}</div> : null}
      </CardContent>
    </Card>
  );
}

/** Horizontal bar breakdown used for the analytics cards. */
export function BarList({ data, total }: { data: Record<string, number>; total: number }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">No data yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {entries.map(([label, count]) => (
        <li key={label}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="truncate">{label}</span>
            <span className="text-muted-foreground tabular-nums">{count}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${total > 0 ? Math.max(4, (count / total) * 100) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
