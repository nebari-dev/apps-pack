import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/*
 * Placeholders for data that is still on its way. Pages render their static
 * chrome (headings, buttons, labels, table headers, tabs) for real at once;
 * only the parts that wait on a request use these. Each loading page
 * announces itself once with a visually hidden status, and the placeholders
 * are hidden from assistive tech (the registry Skeleton is aria-hidden, and
 * its pulse is gated on motion-safe).
 */

/** A visually hidden status naming what is loading, e.g. "Loading apps". */
export function LoadingStatus({ label }: { label: string }) {
  return (
    <p role="status" className="sr-only">
      {label}
    </p>
  );
}

/**
 * Wraps a self-contained placeholder: the status line and the aria-busy
 * placeholder. The status sits outside the busy element so screen readers do
 * not hold its announcement back.
 */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  /** What is loading, announced once, e.g. "Loading logs". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <LoadingStatus label={label} />
      <div aria-busy="true" aria-hidden="true" data-slot="loading-region" className={className}>
        {children}
      </div>
    </>
  );
}

/** A Skeleton line centred in a box with the height of the text it replaces. */
export function TextLine({ box = "h-5", className }: { box?: string; className?: string }) {
  return (
    <div aria-hidden="true" className={cn("flex items-center", box)}>
      <Skeleton className={className} />
    </div>
  );
}

/** Badge-sized pill (Badge is 22px tall: py-0.5 + leading-4 + border). */
export function PillSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-5.5 w-16 rounded-full", className)} />;
}

/**
 * Placeholder rows for the apps table body, cell for cell like
 * {@link AppsTable}'s rows (Type, Source, Replicas and Owner from md up).
 * Rendered inside the real table, under its real column headers.
 */
export function AppsTableRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return Array.from({ length: rows }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
    <TableRow key={i} data-slot="skeleton-row">
      <TableCell>
        <Skeleton className="size-4 rounded-[2px]" />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-md max-sm:hidden" />
          <div className="min-w-0 max-sm:max-w-32">
            <TextLine className={i % 2 ? "w-24" : "w-32"} />
            <TextLine box="h-4" className="h-3 w-40 max-sm:w-28" />
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <PillSkeleton className="w-14" />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <PillSkeleton className="w-12" />
      </TableCell>
      <TableCell>
        <PillSkeleton className="w-20" />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <TextLine className="w-8" />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <TextLine className="w-20" />
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Skeleton className="size-7 rounded-md max-sm:hidden" />
          <Skeleton className="size-7 rounded-md max-sm:hidden" />
          <Skeleton className="size-7 rounded-md" />
        </div>
      </TableCell>
    </TableRow>
  ));
}

/** A labelled field whose control is still loading: the real label over an input-sized block. */
function FieldSkeleton({ label, wide = false }: { label: string; wide?: boolean }) {
  return (
    <div className={cn("space-y-1.5", wide && "sm:col-span-2")}>
      <Label>{label}</Label>
      <Skeleton className="h-8.5 rounded-md" />
    </div>
  );
}

/** A form card whose title is known but whose fields depend on the App's source. */
function SectionSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <TextLine className="w-96 max-w-full" />
        <Skeleton className="h-8.5 rounded-md" />
      </CardContent>
    </Card>
  );
}

/**
 * The edit form while the App loads: the real section titles and, for Basics
 * (the same fields for every App), the real labels; values are placeholders.
 * The sections below Basics depend on the App's source, so they show a title
 * over a placeholder body. `actions` holds the form's real buttons.
 */
export function AppFormSkeleton({ actions }: { actions: ReactNode }) {
  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent aria-hidden="true" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FieldSkeleton label="Name" />
          <FieldSkeleton label="Display name" />
          <FieldSkeleton label="Description" wide />
          <FieldSkeleton label="Thumbnail URL" />
          <FieldSkeleton label="Namespace" />
          <FieldSkeleton label="App type" />
        </CardContent>
      </Card>
      <SectionSkeleton title="Source" />
      <SectionSkeleton title="Runtime" />
      <SectionSkeleton title="Access" />
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <TextLine className="w-64 max-w-full" />
        <div className="flex flex-col gap-2 sm:ml-auto sm:flex-row">{actions}</div>
      </div>
    </div>
  );
}

/** Placeholder log lines inside the log pane's frame. */
export function LogSkeleton() {
  const widths = ["w-11/12", "w-3/4", "w-5/6", "w-2/3", "w-4/5", "w-1/2"];
  return (
    <LoadingRegion label="Loading logs" className="space-y-2 rounded-md bg-muted p-3">
      {widths.map((w) => (
        <Skeleton key={w} className={cn("h-3 bg-muted-foreground/20", w)} />
      ))}
    </LoadingRegion>
  );
}

/** Placeholder rows for a short list in a card (events, conditions). */
export function ListSkeleton({ label, rows = 3 }: { label?: string; rows?: number }) {
  const lines = Array.from({ length: rows }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
    <div key={i} className="space-y-1.5">
      <TextLine className="w-1/3" />
      <TextLine className="w-2/3" />
    </div>
  ));
  // Without a label the page already announces what is loading.
  if (!label) {
    return (
      <div aria-hidden="true" className="space-y-3">
        {lines}
      </div>
    );
  }
  return (
    <LoadingRegion label={label} className="space-y-3">
      {lines}
    </LoadingRegion>
  );
}

/** Stand-in for a metric value and its sparkline inside a stat card. */
export function MetricSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-2">
      <TextLine box="h-8" className="h-6 w-16" />
      <Skeleton className="h-8" />
    </div>
  );
}
