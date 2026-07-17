import { CheckCircle2, CircleDashed, Loader2, PauseCircle, XCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
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
import { Label } from '@/ui/label';
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

export function SourceBadge({ source }: { source: string }) {
  return <Badge variant="ghost" className="border border-border font-mono text-xs">{source}</Badge>;
}

/** Shown for Python/pixi apps (runtime.pixiTask set); static apps get no extra badge. */
export function KindBadge({ pixiTask }: { pixiTask?: string }) {
  if (!pixiTask) return null;
  return <Badge variant="ghost" className="border border-border font-mono text-xs">python</Badge>;
}

/** Deterministic accent color from a string so fallback tiles stay stable. */
const TILE_COLORS = [
  'bg-blue-500/15 text-blue-600 dark:text-blue-300',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  'bg-cyan-500/15 text-cyan-600 dark:text-cyan-300',
];

function hashIndex(seed: string, mod: number) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % mod;
}

/** App avatar: the thumbnail if set, else a colored monogram tile. */
export function AppThumbnail({
  name,
  displayName,
  thumbnail,
  className,
}: {
  name: string;
  displayName?: string;
  thumbnail?: string;
  className?: string;
}) {
  const label = (displayName || name).trim();
  const initials = label.slice(0, 2).toUpperCase();
  if (thumbnail) {
    return (
      <img
        src={thumbnail}
        alt=""
        className={cn('shrink-0 rounded-md border border-border object-cover', className)}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md border border-border font-semibold text-xs',
        TILE_COLORS[hashIndex(name, TILE_COLORS.length)],
        className,
      )}
    >
      {initials}
    </div>
  );
}

/** Minimal inline sparkline for a short numeric series. */
export function Sparkline({
  data,
  className,
  width = 120,
  height = 32,
}: {
  data: number[];
  className?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return <div className={cn('text-muted-foreground text-xs', className)}>collecting…</div>;
  }
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      className={cn('text-primary', className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="usage trend"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Destructive delete confirmation that requires typing the app name — guards an
 * action that also tears down routing, TLS, and the OIDC client.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  appName,
  displayName,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  displayName?: string;
  loading?: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === appName;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {displayName || appName}?</DialogTitle>
          <DialogDescription>
            This removes the app, its routing, TLS certificate, and OIDC client. It cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-name">
            Type <span className="font-mono font-semibold text-foreground">{appName}</span> to
            confirm
          </Label>
          <Input
            id="confirm-name"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches && !loading) onConfirm();
            }}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button variant="destructive" disabled={!matches} loading={loading} onClick={onConfirm}>
            Delete app
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Parse "12m" → 12 (millicores) or "34Mi" → 34 (Mi) for charting. */
export function metricValue(raw: string): number {
  const match = raw.match(/^([\d.]+)/);
  return match ? Number(match[1]) : 0;
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
