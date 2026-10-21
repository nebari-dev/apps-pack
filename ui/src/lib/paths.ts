import type { App } from "@/lib/types";

/**
 * The namespace most Apps live in (the chart's default `api.allowedNamespaces`).
 * UI page URLs leave it out: `/apps/<name>` rather than `/apps/apps/<name>`.
 */
export const DEFAULT_NAMESPACE = "apps";

/**
 * The UI page path for an App: `/apps/<name>` in the default namespace,
 * `/apps/<namespace>/<name>` elsewhere (names are unique per namespace only).
 * `suffix` is appended as a path segment, e.g. `appPath(app, "edit")`.
 * For page links only; API paths live in `lib/api.ts`.
 */
export function appPath(app: Pick<App, "namespace" | "name">, suffix?: string): string {
  const base =
    app.namespace === DEFAULT_NAMESPACE
      ? `/apps/${app.name}`
      : `/apps/${app.namespace}/${app.name}`;
  return suffix ? `${base}/${suffix}` : base;
}
