import { useMutation, useQuery } from "@tanstack/react-query";
import { Pause, Play, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmDeleteDialog } from "@/components/app-bits";
import { AppsTable, appType, type Sort, type SortCol } from "@/components/apps-table";
import { Onboarding } from "@/components/onboarding";
import { errorMessage, QueryError } from "@/components/query-error";
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
import { api } from "@/lib/api";
import { listInterval } from "@/lib/polling";
import type { App } from "@/lib/types";
import { cn } from "@/lib/utils";

const errMessage = errorMessage;

const PHASES = ["Running", "Deploying", "Pending", "Stopped", "Failed"] as const;

export function AppsPage() {
  const heading = usePageTitle("Apps");
  const apps = useQuery({
    queryKey: ["apps"],
    queryFn: () => api.listApps(),
    refetchInterval: (q) => listInterval(q.state.data),
  });
  const [filter, setFilter] = useState("");
  const [phaseFilter, setPhaseFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>({ col: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState("");

  const invalidate = useInvalidateApps();
  const actions = useAppActions({ onDeleted: () => setDeleteTarget(null) });

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
      return [
        a.name,
        a.displayName,
        a.namespace,
        appType(a),
        a.source?.type ?? "",
        a.owner,
        a.status.phase,
      ]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
    const val = (a: App): string => {
      switch (sort.col) {
        case "namespace":
          return a.namespace;
        case "type":
          return appType(a);
        case "source":
          return a.source?.type ?? "";
        case "status":
          return a.status.phase;
        case "owner":
          return a.owner ?? "";
        default:
          return (a.displayName || a.name).toLowerCase();
      }
    };
    out = [...out].sort((a, b) => val(a).localeCompare(val(b)) * (sort.dir === "asc" ? 1 : -1));
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

  // Each app is acted on independently: one failure (a 403, an app deleted
  // meanwhile) must not hide that the others succeeded.
  const bulkAction = useMutation({
    mutationFn: async (action: "start" | "stop" | "delete") => {
      const targets = selectedApps;
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
            Apps
          </h1>
          <p className="text-muted-foreground text-sm">
            Everything launched through the Apps Pack, across your namespaces.
          </p>
        </div>
        <Button render={<Link to="/launch">Launch app</Link>} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 z-10 size-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, source, status…"
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
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            label="All"
            count={list.length}
            active={phaseFilter === null}
            onClick={() => setPhaseFilter(null)}
          />
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

      {selectedApps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2">
          <span className="font-medium text-sm">{selectedApps.length} selected</span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              loading={bulkAction.isPending && bulkAction.variables === "start"}
              onClick={() => bulkAction.mutate("start")}
            >
              <Play /> Start
            </Button>
            <Button
              variant="outline"
              size="sm"
              loading={bulkAction.isPending && bulkAction.variables === "stop"}
              onClick={() => bulkAction.mutate("stop")}
            >
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
      ) : apps.isError ? (
        <QueryError
          title="Could not load apps"
          error={apps.error}
          onRetry={() => void apps.refetch()}
        />
      ) : list.length === 0 ? (
        <Onboarding />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground text-sm">
          No apps match your filter.
        </p>
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
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}
