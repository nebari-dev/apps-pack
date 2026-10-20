import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppThumbnail } from "@/components/app-bits";
import type { App } from "@/lib/types";

/**
 * Classes for a `TableRow` that carries `data-phase={app.status.phase}`: Failed
 * rows get a faint destructive tint (hover deepens it), the rest keep the
 * table's own hover. Shared by every apps table so they cannot drift.
 */
export const APP_ROW_CLASS =
  "data-[phase=Failed]:bg-destructive/40 data-[phase=Failed]:hover:bg-destructive/60";

/** First cell of an apps table: thumbnail, display-name link and a mono sub-line. */
export function AppNameCell({
  app,
  subline = app.name,
}: {
  app: Pick<App, "name" | "namespace"> & Partial<Pick<App, "displayName" | "thumbnail">>;
  /** Shown under the name; defaults to the App's name. */
  subline?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <AppThumbnail
        name={app.name}
        displayName={app.displayName}
        thumbnail={app.thumbnail}
        className="size-9"
      />
      <div className="min-w-0">
        <Link to={`/apps/${app.namespace}/${app.name}`} className="font-medium hover:underline">
          {app.displayName || app.name}
        </Link>
        <p className="truncate font-mono text-muted-foreground text-xs">{subline}</p>
      </div>
    </div>
  );
}
