import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Pause, Play, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDeleteDialog, sourceLabel } from "@/components/app-bits";
import {
  AppsTable,
  appType,
  canStart,
  canStop,
  type Sort,
  type SortCol,
} from "@/components/apps-table";
import { Onboarding } from "@/components/onboarding";
import { errorMessage, QueryError } from "@/components/query-error";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  appKey,
  appLabel,
  runAppAction,
  useAppActions,
  useInvalidateApps,
} from "@/hooks/use-app-actions";
import { usePageTitle } from "@/hooks/use-page-title";
import { useRestarts } from "@/hooks/use-restarts";
import { isMine } from "@/lib/access";
import { api } from "@/lib/api";
import { needsAttention } from "@/lib/attention";
import { getUser } from "@/lib/auth";
import { comparePhase } from "@/lib/phase";
import { listInterval } from "@/lib/polling";
import type { App } from "@/lib/types";
import { cn } from "@/lib/utils";

const errMessage = errorMessage;

const PHASES = ["Running", "Deploying", "Pending", "Idle", "Stopped", "Failed"] as const;

/** Status filter value for Failed apps plus apps whose containers restarted. */
const ATTENTION = "attention";

export function AppsPage() {
  const heading = usePageTitle("Apps");
  const apps = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: (q) => listInterval(q.state.data),
  });
  const { restarts, loading: restartsLoading, error: restartsError } = useRestarts();
  // Signed-in user; null when auth is off, which hides the Mine chip.
  const me = getUser()?.name || null;
  const [filter, setFilter] = useState("");
  // A phase, ATTENTION, or null for every status.
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);
  // null until the user toggles Mine: it then defaults to on whenever they own or manage an app.
  const [mineChoice, setMineChoice] = useState<boolean | null>(null);
  // Most severe first, so a Failed app is never buried under healthy ones.
  const [sort, setSort] = useState<Sort>({ col: "status", dir: "asc" });
  const searchRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState("");

  const invalidate = useInvalidateApps();
  const actions = useAppActions({ onDeleted: () => setDeleteTarget(null) });

  const list = apps.data ?? [];
  const mineCount = me ? list.filter((a) => isMine(a, me)).length : 0;
  const mine = me !== null && (mineChoice ?? mineCount > 0);
  // Mine scopes everything below it: the status chips, the banner and the rows.
  const scoped = useMemo(() => (mine ? list.filter((a) => isMine(a, me)) : list), [list, mine, me]);
  const phaseCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of scoped) counts[a.status.phase] = (counts[a.status.phase] ?? 0) + 1;
    return counts;
  }, [scoped]);
  const attention = useMemo(
    () => scoped.filter((a) => needsAttention(a, restarts)),
    [scoped, restarts],
  );
  const failedCount = attention.filter((a) => a.status.phase === "Failed").length;

  const rows = useMemo(() => {
    const term = filter.trim().toLowerCase();
    let out = scoped.filter((a) => {
      if (phaseFilter === ATTENTION) {
        if (!needsAttention(a, restarts)) return false;
      } else if (phaseFilter && a.status.phase !== phaseFilter) return false;
      if (!term) return true;
      return [
        a.name,
        a.displayName,
        a.namespace,
        appType(a),
        a.source?.type ?? "",
        sourceLabel(a.source?.type ?? ""),
        a.owner,
        a.status.phase,
      ]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
    const val = (a: App): string => {
      switch (sort.col) {
        case "type":
          return appType(a);
        case "source":
          return a.source?.type ?? "";
        case "owner":
          return a.owner ?? "";
        default:
          return (a.displayName || a.name).toLowerCase();
      }
    };
    // Status sorts by severity (Failed first ascending), the rest alphabetically.
    const cmp = (a: App, b: App) =>
      sort.col === "status"
        ? comparePhase(a.status.phase, b.status.phase)
        : val(a).localeCompare(val(b));
    // Ties fall back to the display name (always A→Z) so the order is stable.
    const byName = (a: App) => (a.displayName || a.name).toLowerCase();
    out = [...out].sort(
      (a, b) => cmp(a, b) * (sort.dir === "asc" ? 1 : -1) || byName(a).localeCompare(byName(b)),
    );
    return out;
  }, [scoped, filter, phaseFilter, sort, restarts]);

  const selectedApps = useMemo(() => rows.filter((a) => selected.has(appKey(a))), [rows, selected]);
  const allSelected = rows.length > 0 && rows.every((a) => selected.has(appKey(a)));
  const someSelected = selectedApps.length > 0 && !allSelected;
  // The bulk bar only offers what applies, and each action only touches the
  // selected apps it applies to.
  const startable = selectedApps.filter(canStart);
  const stoppable = selectedApps.filter(canStop);

  // "/" jumps to the search field from anywhere on the page but a form control.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const clearFilters = () => {
    setFilter("");
    setPhaseFilter(null);
    setMineChoice(false);
  };
  const showAttention = () => {
    setFilter("");
    setPhaseFilter(ATTENTION);
  };

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

  // Each app is acted on independently: one failure (a 403, an app deleted
  // meanwhile) must not hide that the others succeeded.
  const bulkAction = useMutation({
    mutationFn: async (action: "start" | "stop" | "delete") => {
      const targets = action === "start" ? startable : action === "stop" ? stoppable : selectedApps;
      const results = await Promise.allSettled(targets.map((a) => runAppAction(action, a)));
      const failed = targets.flatMap((app, i) => {
        const r = results[i];
        return r.status === "rejected" ? [{ app, reason: errMessage(r.reason) }] : [];
      });
      return { action, total: targets.length, failed };
    },
    onSuccess: ({ action, total, failed }) => {
      invalidate();
      setBulkDeleteOpen(false);
      setBulkConfirm("");
      // Keep the failures selected so they can be retried.
      setSelected(new Set(failed.map(({ app }) => appKey(app))));
      const verb = action === "delete" ? "Deleted" : action === "stop" ? "Stopped" : "Started";
      if (failed.length === 0) {
        toast.add({ type: "success", title: `${verb} ${total} app(s)` });
        return;
      }
      toast.add({
        type: "error",
        title: `${total - failed.length} of ${total} succeeded`,
        description: failed.map(({ app, reason }) => `${appLabel(app)}: ${reason}`).join("; "),
      });
    },
    onError: (err) =>
      toast.add({ type: "error", title: "Bulk action failed", description: errMessage(err) }),
  });

  const toggleSort = (col: SortCol) =>
    setSort((s) =>
      s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
            Apps
          </h1>
          <p className="text-muted-foreground text-sm">
            Web applications running on this Nebari cluster.
          </p>
        </div>
        <Button className="self-start sm:self-auto" render={<Link to="/launch">Launch app</Link>} />
      </div>

      {/* Hidden while either list loads, so it never flashes or claims the all-clear. */}
      {apps.isSuccess && !restartsLoading ? (
        <AttentionBanner
          count={attention.length}
          failed={failedCount}
          error={restartsError}
          active={phaseFilter === ATTENTION}
          onShow={showAttention}
        />
      ) : null}

      {apps.isSuccess && list.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:max-w-sm">
            <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 z-10 size-4 text-muted-foreground" />
            <Input
              ref={searchRef}
              placeholder="Search by name, source, status…"
              aria-keyshortcuts="/"
              className="pr-9 pl-9"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter ? (
              <button
                type="button"
                aria-label="Clear search"
                className="-translate-y-1/2 absolute top-1/2 right-2 z-10 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setFilter("")}
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd
                aria-hidden
                className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2.5 z-10 rounded-sm border border-border bg-muted px-1.5 font-mono text-muted-foreground text-xs leading-5"
              >
                /
              </kbd>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {me ? (
              <>
                <FilterChip
                  label="Mine"
                  count={mineCount}
                  active={mine}
                  onClick={() => setMineChoice(!mine)}
                />
                <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
              </>
            ) : null}
            <FilterChip
              label="All"
              count={scoped.length}
              active={phaseFilter === null}
              onClick={() => setPhaseFilter(null)}
            />
            {attention.length > 0 || phaseFilter === ATTENTION ? (
              <FilterChip
                label="Needs attention"
                count={attention.length}
                active={phaseFilter === ATTENTION}
                onClick={() => setPhaseFilter(ATTENTION)}
              />
            ) : null}
            {PHASES.filter((p) => phaseCounts[p]).map((p) => (
              <FilterChip
                key={p}
                label={p}
                count={phaseCounts[p]}
                active={phaseFilter === p}
                onClick={() => setPhaseFilter(p)}
              />
            ))}
          </div>
        </div>
      )}

      {selectedApps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
          <span className="font-medium text-sm">{selectedApps.length} selected</span>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            {startable.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                loading={bulkAction.isPending && bulkAction.variables === "start"}
                onClick={() => bulkAction.mutate("start")}
              >
                <Play /> Start
              </Button>
            ) : null}
            {stoppable.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                loading={bulkAction.isPending && bulkAction.variables === "stop"}
                onClick={() => bulkAction.mutate("stop")}
              >
                <Pause /> Stop
              </Button>
            ) : null}
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
      ) : apps.isError ? (
        <QueryError
          title="Could not load apps"
          error={apps.error}
          onRetry={() => void apps.refetch()}
        />
      ) : list.length === 0 ? (
        <Onboarding />
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10">
          <p className="text-muted-foreground text-sm">No apps match your filter.</p>
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <AppsTable
          rows={rows}
          sort={sort}
          onToggleSort={toggleSort}
          selected={selected}
          allSelected={allSelected}
          someSelected={someSelected}
          onToggleAll={toggleAll}
          onToggleOne={toggleOne}
          actions={actions}
          onDelete={setDeleteTarget}
          restarts={restarts}
        />
      )}

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        appName={deleteTarget?.name ?? ""}
        displayName={deleteTarget?.displayName}
        loading={actions.remove.isPending}
        onConfirm={() => deleteTarget && actions.remove.mutate(deleteTarget)}
      />

      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => {
          if (!open) setBulkConfirm("");
          setBulkDeleteOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedApps.length} apps?</DialogTitle>
            <DialogDescription>
              This removes each app, its routing, TLS certificate, and OIDC client. It cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-sm">
              Type <span className="font-mono font-semibold text-foreground">delete</span> to
              confirm.
            </p>
            <Input
              autoComplete="off"
              value={bulkConfirm}
              onChange={(e) => setBulkConfirm(e.target.value)}
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              disabled={bulkConfirm.trim() !== "delete"}
              loading={bulkAction.isPending}
              onClick={() => bulkAction.mutate("delete")}
            >
              Delete {selectedApps.length} apps
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One line above the list when any app is Failed or restarting, with an
 * action that filters the list to them. A failed metrics request is said
 * out loud rather than read as "nothing restarted".
 */
function AttentionBanner({
  count,
  failed,
  error,
  active,
  onShow,
}: {
  count: number;
  failed: number;
  error: unknown;
  active: boolean;
  onShow: () => void;
}) {
  const unchecked = error ? `Restart counts are unavailable: ${errMessage(error)}` : "";
  if (count === 0) {
    return unchecked ? (
      <Alert>
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Could not check apps for restarts</AlertTitle>
        <AlertDescription>{errMessage(error)}</AlertDescription>
      </Alert>
    ) : null;
  }
  const restarting = count - failed;
  const detail = [failed ? `${failed} failed` : "", restarting ? `${restarting} restarting` : ""]
    .filter(Boolean)
    .join(", ");
  return (
    // A polite live region: it appears on load and on every poll that changes it.
    <Alert variant="warning" role="status">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>
        {count === 1 ? "1 app needs attention" : `${count} apps need attention`}
      </AlertTitle>
      <AlertDescription>{[detail, unchecked].filter(Boolean).join(". ")}</AlertDescription>
      {active ? null : (
        <AlertAction>
          <Button variant="outline" size="xs" onClick={onShow}>
            Show
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium text-xs motion-safe:transition-colors motion-safe:duration-(--duration-fast)",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("tabular-nums", !active && "text-muted-foreground")}>{count}</span>
    </button>
  );
}
