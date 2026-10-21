import { useMutation, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/components/query-error";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { App } from "@/lib/types";

export type AppAction = "start" | "stop" | "restart" | "delete";

export const appLabel = (app: App) => app.displayName || app.name;
export const appKey = (app: App) => `${app.namespace}/${app.name}`;
export const isStopped = (app: App) =>
  (app.status.replicas?.desired ?? app.runtime?.replicas ?? 1) === 0;

/** Calls the API for one action on one App. */
export function runAppAction(action: AppAction, app: App): Promise<unknown> {
  switch (action) {
    case "start":
      return api.startApp(app.namespace, app.name);
    case "stop":
      return api.stopApp(app.namespace, app.name);
    case "restart":
      return api.restartApp(app.namespace, app.name);
    case "delete":
      return api.deleteApp(app.namespace, app.name);
  }
}

const DONE: Record<AppAction, { title: string; description?: string }> = {
  start: { title: "Started" },
  stop: { title: "Stopped" },
  restart: { title: "Restarting", description: "Pods are rolling now." },
  delete: { title: "Deleted" },
};

/** The apps list (with its restart counts) and the App's own page both show the result. */
export function useInvalidateApps() {
  const queryClient = useQueryClient();
  return (app?: App) => {
    if (app) void queryClient.invalidateQueries({ queryKey: ["app", app.namespace, app.name] });
    void queryClient.invalidateQueries({ queryKey: ["apps"] });
    void queryClient.invalidateQueries({ queryKey: ["cluster-metrics"] });
  };
}

/**
 * Start, stop, restart and delete for a single App, each reporting its result
 * in a toast and refreshing every query that shows the App.
 */
export function useAppActions({ onDeleted }: { onDeleted?: (app: App) => void } = {}) {
  const invalidate = useInvalidateApps();
  const useAction = (action: AppAction) =>
    useMutation({
      mutationFn: (app: App) => runAppAction(action, app),
      onSuccess: (_data, app) => {
        invalidate(app);
        const done = DONE[action];
        toast.add({
          type: "success",
          title: `${done.title} ${appLabel(app)}`,
          description: done.description,
        });
        if (action === "delete") onDeleted?.(app);
      },
      onError: (err, app) =>
        toast.add({
          type: "error",
          title: `Failed to ${action} ${appLabel(app)}`,
          description: errorMessage(err),
        }),
    });

  const actions = {
    start: useAction("start"),
    stop: useAction("stop"),
    restart: useAction("restart"),
    remove: useAction("delete"),
  };
  /** Whether `mutation` is currently running for `app`. */
  const isPendingFor = (mutation: (typeof actions)[keyof typeof actions], app: App) =>
    mutation.isPending &&
    mutation.variables !== undefined &&
    appKey(mutation.variables) === appKey(app);
  return { ...actions, isPendingFor };
}
