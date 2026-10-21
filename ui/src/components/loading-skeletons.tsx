import type { ReactNode } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/*
 * Loading placeholders that mirror the layout they stand in for, so the page
 * keeps its shape while data arrives instead of jumping from a spinner. Each
 * region is announced once: a visually hidden status names what is loading,
 * and the placeholder itself is aria-busy and hidden from assistive tech (the
 * registry Skeleton is aria-hidden, and its pulse is gated on motion-safe).
 */

/**
 * Wraps a placeholder: a status line for screen readers ("Loading apps") and
 * the aria-busy placeholder. The status sits outside the busy element so
 * screen readers do not hold its announcement back.
 */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  /** What is loading, announced once, e.g. "Loading apps". */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <>
      <p role="status" className="sr-only">
        {label}
      </p>
      <div aria-busy="true" aria-hidden="true" data-slot="loading-region" className={className}>
        {children}
      </div>
    </>
  );
}

/** A Skeleton line centred in a box with the height of the text it replaces. */
function TextLine({ box = "h-5", className }: { box?: string; className?: string }) {
  return (
    <div className={cn("flex items-center", box)}>
      <Skeleton className={className} />
    </div>
  );
}

/** Badge-sized pill (Badge is 22px tall: py-0.5 + leading-4 + border). */
function PillSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-5.5 w-16 rounded-full", className)} />;
}

/** Page heading plus its one-line subtitle, sized like the pages' own. */
function HeadingSkeleton({
  back = false,
  subtitle = true,
}: {
  back?: boolean;
  subtitle?: boolean;
}) {
  return (
    <div>
      {back ? <TextLine className="mb-1 w-20" /> : null}
      <TextLine box="h-8" className="h-6 w-48" />
      {subtitle ? <TextLine className="w-72 max-w-full" /> : null}
    </div>
  );
}

/** Route fallback while a page's code loads: a heading over a content block. */
export function PageSkeleton() {
  return (
    <LoadingRegion label="Loading page" className="space-y-6">
      <HeadingSkeleton />
      <Skeleton shape="block" className="h-64" />
    </LoadingRegion>
  );
}

const HEADS = [
  { label: "App" },
  { label: "Type", wide: true },
  { label: "Source", wide: true },
  { label: "Status" },
  { label: "Replicas", wide: true },
  { label: "Owner", wide: true },
] as const;

/**
 * The apps table while the list loads: the real table frame and column
 * headings with placeholder rows, showing the same columns at each width as
 * {@link AppsTable} (Type, Source, Replicas and Owner from md up).
 */
export function AppsTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <LoadingRegion label="Loading apps">
      <Table
        className="max-sm:[&_td]:px-2 max-sm:[&_th]:px-2"
        scrollContainerProps={{ tabIndex: -1 }}
      >
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Skeleton className="size-4 rounded-[2px]" />
            </TableHead>
            {HEADS.map((h) => (
              <TableHead key={h.label} className={cn("wide" in h && "hidden md:table-cell")}>
                {h.label}
              </TableHead>
            ))}
            <TableHead className="text-right">
              <span className="max-sm:sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
            <TableRow key={i}>
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
          ))}
        </TableBody>
      </Table>
    </LoadingRegion>
  );
}

/** A card with a title line and body lines, standing in for a stat card. */
function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <Card>
      <CardHeader>
        <TextLine box="h-6" className="w-20" />
      </CardHeader>
      <CardContent className="space-y-2">
        <TextLine box="h-8" className="h-6 w-24" />
        {Array.from({ length: lines - 1 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines have no identity
          <TextLine key={i} box="h-4" className="h-3 w-3/4" />
        ))}
      </CardContent>
    </Card>
  );
}

/** An app's page while it loads: header, the four summary cards, tabs and a panel. */
export function AppDetailSkeleton() {
  return (
    <LoadingRegion label="Loading app" className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 gap-4">
          <Skeleton className="mt-6 size-12 rounded-md" />
          <div className="min-w-0 flex-1">
            <TextLine className="mb-1 w-14" />
            <div className="flex flex-wrap items-center gap-3">
              <TextLine box="h-8" className="h-6 w-48" />
              <PillSkeleton className="w-12" />
              <PillSkeleton className="w-20" />
            </div>
            <TextLine className="mt-1 w-80 max-w-full" />
            <TextLine className="mt-1 w-56 max-w-full" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-18 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
      <div className="space-y-8">
        <Skeleton className="h-9 w-64 max-w-full rounded-md" />
        <Skeleton shape="block" className="h-40" />
      </div>
    </LoadingRegion>
  );
}

/** One form section: a card with a title and a two-column grid of fields. */
function FormSectionSkeleton({
  fields,
  wide = [],
  subtitle = true,
}: {
  fields: number;
  /** Indexes of fields that span both columns. */
  wide?: number[];
  subtitle?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <TextLine box="h-6" className="w-24" />
        {subtitle ? <TextLine className="w-96 max-w-full" /> : null}
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: fields }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder fields have no identity
          <div key={i} className={cn("space-y-1.5", wide.includes(i) && "sm:col-span-2")}>
            <TextLine className="w-24" />
            <Skeleton className="h-8.5 rounded-md" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** The edit page while the app loads: back link, heading and the form's sections. */
export function AppFormSkeleton() {
  return (
    <LoadingRegion label="Loading app" className="space-y-6">
      <HeadingSkeleton back subtitle={false} />
      <div className="max-w-3xl space-y-6">
        <FormSectionSkeleton fields={6} wide={[2]} subtitle={false} />
        <FormSectionSkeleton fields={2} />
        <FormSectionSkeleton fields={2} wide={[0, 1]} />
      </div>
    </LoadingRegion>
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

/** Placeholder rows for a short list in a card (events). */
export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <LoadingRegion label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
        <div key={i} className="space-y-1.5">
          <TextLine className="w-1/3" />
          <TextLine className="w-2/3" />
        </div>
      ))}
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
