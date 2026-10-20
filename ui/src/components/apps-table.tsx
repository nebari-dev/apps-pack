import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ExternalLink,
  Eye,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PhaseBadge, SourceBadge } from "@/components/app-bits";
import { APP_ROW_CLASS, AppNameCell } from "@/components/app-name-cell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { appKey, appLabel, isStopped, type useAppActions } from "@/hooks/use-app-actions";
import type { App } from "@/lib/types";

export type SortCol = "name" | "namespace" | "type" | "source" | "status" | "owner";
export type SortDir = "asc" | "desc";
export type Sort = { col: SortCol; dir: SortDir };

/** App kind shown in the Type column: pixi-launched apps are python, the rest static. */
export const appType = (app: App) => (app.runtime?.pixiTask ? "python" : "static");

export interface AppsTableProps {
  rows: App[];
  sort: Sort;
  onToggleSort: (col: SortCol) => void;
  selected: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  onToggleOne: (app: App) => void;
  actions: ReturnType<typeof useAppActions>;
  onDelete: (app: App) => void;
}

/** The apps list: sortable columns, row selection and per-row actions. */
export function AppsTable({
  rows,
  sort,
  onToggleSort,
  selected,
  allSelected,
  someSelected,
  onToggleAll,
  onToggleOne,
  actions,
  onDelete,
}: AppsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              aria-label="Select all"
              checked={allSelected}
              indeterminate={someSelected}
              onCheckedChange={onToggleAll}
            />
          </TableHead>
          <SortableHead label="App" col="name" sort={sort} onToggle={onToggleSort} />
          <SortableHead label="Namespace" col="namespace" sort={sort} onToggle={onToggleSort} />
          <SortableHead label="Type" col="type" sort={sort} onToggle={onToggleSort} />
          <SortableHead label="Source" col="source" sort={sort} onToggle={onToggleSort} />
          <SortableHead label="Status" col="status" sort={sort} onToggle={onToggleSort} />
          <TableHead>Replicas</TableHead>
          <SortableHead label="Owner" col="owner" sort={sort} onToggle={onToggleSort} />
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((app) => {
          const stopped = isStopped(app);
          const checked = selected.has(appKey(app));
          return (
            <TableRow
              key={appKey(app)}
              data-selected={checked || undefined}
              data-phase={app.status.phase}
              className={APP_ROW_CLASS}
            >
              <TableCell>
                <Checkbox
                  aria-label={`Select ${appLabel(app)}`}
                  checked={checked}
                  onCheckedChange={() => onToggleOne(app)}
                />
              </TableCell>
              <TableCell>
                <AppNameCell app={app} />
              </TableCell>
              <TableCell className="text-muted-foreground">{app.namespace}</TableCell>
              <TableCell>
                <SourceBadge source={appType(app)} />
              </TableCell>
              <TableCell>
                <SourceBadge source={app.source?.type ?? "—"} />
              </TableCell>
              <TableCell>
                <PhaseBadge phase={app.status.phase} />
              </TableCell>
              <TableCell className="tabular-nums">
                {app.status.replicas
                  ? `${app.status.replicas.ready}/${app.status.replicas.desired}`
                  : "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">{app.owner || "—"}</TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <IconLink to={`/apps/${app.namespace}/${app.name}`} label="View">
                    <Eye />
                  </IconLink>
                  <IconLink to={`/apps/${app.namespace}/${app.name}/edit`} label="Edit">
                    <Pencil />
                  </IconLink>
                  {app.status.url && app.status.phase === "Running" ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            render={
                              <a
                                href={app.status.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="Open app"
                              />
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
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Start app"
                            loading={actions.isPendingFor(actions.start, app)}
                            onClick={() => actions.start.mutate(app)}
                          >
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
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Stop app"
                            loading={actions.isPendingFor(actions.stop, app)}
                            onClick={() => actions.stop.mutate(app)}
                          >
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
                          onClick={() => onDelete(app)}
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
  sort: Sort;
  onToggle: (c: SortCol) => void;
}) {
  const active = sort.col === col;
  return (
    <TableHead aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => onToggle(col)}
      >
        {label}
        {active ? (
          sort.dir === "asc" ? (
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
          <Button variant="ghost" size="icon-sm" render={<Link to={to} aria-label={label} />}>
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
