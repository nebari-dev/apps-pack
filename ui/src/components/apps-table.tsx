import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ExternalLink,
  Pause,
  Pencil,
  Play,
  ScrollText,
  Trash2,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PhaseBadge, SourceBadge, TypeBadge } from "@/components/app-bits";
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
import { appKey, appLabel, isIdle, isStopped, type useAppActions } from "@/hooks/use-app-actions";
import { failureReason } from "@/lib/phase";
import type { App } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SortCol = "name" | "type" | "source" | "status" | "owner";
export type SortDir = "asc" | "desc";
export type Sort = { col: SortCol; dir: SortDir };

/** App kind shown in the Type column: pixi-launched apps are python, the rest static. */
export const appType = (app: App) =>
  app.source?.type === "image" ? "container" : app.runtime?.pixiTask ? "python" : "static";

/** Start applies to an App scaled to zero: stopped, or idle (Start wakes it). */
export const canStart = (app: App) => isStopped(app) || isIdle(app);

/** Stop applies to an App that is up or coming up, not one stopped or not yet scheduled. */
export const canStop = (app: App) =>
  !isStopped(app) && app.status.phase !== "Stopped" && app.status.phase !== "Pending";

/** Clicks on these keep their own behavior instead of opening the row's App. */
const INTERACTIVE = "a, button, input, label, [role='checkbox']";

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
  /** Container restarts per App ("namespace/name"), shown under the status. */
  restarts?: Map<string, number>;
}

/** The App's live URL, while it is Running (or Idle: opening it wakes it) and has one. */
export const openUrl = (app: App) =>
  (app.status.phase === "Running" || app.status.phase === "Idle") && app.status.url
    ? app.status.url
    : "";

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
  restarts,
}: AppsTableProps) {
  const navigate = useNavigate();
  // Below md only Status, App and Actions show; below sm the cells tighten,
  // long status reasons wrap anywhere, and the row keeps one icon action
  // (Logs on a Failed App, Open on a Running one, else Stop/Start) - the rest
  // are on the App's page, which the row opens.
  return (
    <Table className="max-sm:[&_td]:px-2 max-sm:[&_th]:px-2">
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
          <SortableHead
            label="Type"
            col="type"
            sort={sort}
            onToggle={onToggleSort}
            className="hidden md:table-cell"
          />
          <SortableHead
            label="Source"
            col="source"
            sort={sort}
            onToggle={onToggleSort}
            className="hidden md:table-cell"
          />
          <SortableHead label="Status" col="status" sort={sort} onToggle={onToggleSort} />
          <TableHead className="hidden md:table-cell">Replicas</TableHead>
          <SortableHead
            label="Owner"
            col="owner"
            sort={sort}
            onToggle={onToggleSort}
            className="hidden md:table-cell"
          />
          <TableHead className="text-right">
            {/* Below sm the column holds one icon, so its name is for screen readers only. */}
            <span className="max-sm:sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((app) => {
          const stopped = isStopped(app);
          const failed = app.status.phase === "Failed";
          const reason = failed ? failureReason(app) : "";
          const restartCount = restarts?.get(appKey(app)) ?? 0;
          const url = openUrl(app);
          const checked = selected.has(appKey(app));
          const detail = `/apps/${app.namespace}/${app.name}`;
          // The whole row opens the App for pointer users; keyboard and screen
          // reader users get the same destination from the name link.
          const openRow = (e: MouseEvent<HTMLTableRowElement>) => {
            if ((e.target as Element).closest(INTERACTIVE)) return;
            navigate(detail);
          };
          return (
            <TableRow
              key={appKey(app)}
              data-selected={checked || undefined}
              data-phase={app.status.phase}
              className={cn("cursor-pointer", APP_ROW_CLASS)}
              onClick={openRow}
            >
              <TableCell>
                <Checkbox
                  aria-label={`Select ${appLabel(app)}`}
                  checked={checked}
                  onCheckedChange={() => onToggleOne(app)}
                />
              </TableCell>
              <TableCell>
                <AppNameCell app={app} subline={`${app.name} · ${app.namespace}`} />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <TypeBadge type={appType(app)} />
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <SourceBadge source={app.source?.type ?? "—"} />
              </TableCell>
              <TableCell>
                <PhaseBadge phase={app.status.phase} />
                {reason ? (
                  <p className="mt-1 text-muted-foreground text-xs wrap-anywhere">{reason}</p>
                ) : null}
                {restartCount > 0 ? (
                  <p className="mt-1 text-muted-foreground text-xs">
                    {restartCount === 1 ? "1 restart" : `${restartCount} restarts`}
                  </p>
                ) : null}
              </TableCell>
              <TableCell className="hidden md:table-cell tabular-nums">
                {app.status.replicas
                  ? `${app.status.replicas.ready}/${app.status.replicas.desired}`
                  : "—"}
              </TableCell>
              <TableCell className="hidden md:table-cell text-muted-foreground">
                {app.owner || "—"}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  {failed ? (
                    <IconLink to={`${detail}?tab=logs`} label="Logs">
                      <ScrollText />
                    </IconLink>
                  ) : null}
                  <IconLink to={`${detail}/edit`} label="Edit" className="max-sm:hidden">
                    <Pencil />
                  </IconLink>
                  {url ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            render={
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-label={`Open ${appLabel(app)}`}
                              />
                            }
                          >
                            <ExternalLink aria-hidden="true" />
                          </Button>
                        }
                      />
                      <TooltipContent>Open in a new tab</TooltipContent>
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
                            className={cn((failed || url) && "max-sm:hidden")}
                            disabled={!canStop(app)}
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
                          className="text-muted-foreground hover:bg-destructive max-sm:hidden hover:text-destructive-foreground focus-visible:bg-destructive focus-visible:text-destructive-foreground"
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
  className,
}: {
  label: string;
  col: SortCol;
  sort: Sort;
  onToggle: (c: SortCol) => void;
  className?: string;
}) {
  const active = sort.col === col;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
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

function IconLink({
  to,
  label,
  className,
  children,
}: {
  to: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={className}
            render={<Link to={to} aria-label={label} />}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
