import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AppForm, type SubmitPayload } from "@/components/app-form";
import { AppFormSkeleton, LoadingStatus, TextLine } from "@/components/loading-skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useArrived } from "@/hooks/use-changed";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api";
import { getConfig } from "@/lib/auth";
import { FADE_IN } from "@/lib/motion";

export function EditPage() {
  const heading = usePageTitle("Edit app");
  const { namespace = "", name = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const app = useQuery({
    queryKey: ["app", namespace, name],
    queryFn: () => api.getApp(namespace, name),
  });
  const capabilities = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities });

  const appsDomain = capabilities.data?.appsDomain || getConfig().appsDomain;
  const appsScheme = getConfig().appsScheme ?? "https";

  const save = useMutation({
    mutationFn: (payload: SubmitPayload) => {
      if (payload.kind !== "patch") throw new Error("unexpected payload for edit");
      return api.patchApp(namespace, name, payload.body);
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["app", namespace, name] });
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      toast.add({ type: "success", title: `Saved ${updated.displayName || updated.name}` });
      void navigate(`/apps/${namespace}/${name}`);
    },
    onError: (err) =>
      toast.add({
        type: "error",
        title: "Save failed",
        description: err instanceof Error ? err.message : String(err),
      }),
  });

  // The form fades in where its placeholder stood; a cached App shows at once.
  const arrived = useArrived(app.data !== undefined);
  const back = `/apps/${namespace}/${name}`;

  if (app.isError || (!app.isLoading && !app.data)) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load app</AlertTitle>
        <AlertDescription>{String(app.error ?? "not found")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {app.data ? null : <LoadingStatus label="Loading app" />}
      <div>
        <Link
          to={back}
          className="mb-1 inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />{" "}
          {app.data ? (
            <span className={arrived ? FADE_IN : undefined}>
              {app.data.displayName || app.data.name}
            </span>
          ) : (
            <>
              {/* The App's display name is not known yet: its name stands in for screen readers. */}
              <span className="sr-only">{name}</span>
              <TextLine className="w-24" />
            </>
          )}
        </Link>
        <h1 ref={heading} tabIndex={-1} className="font-semibold text-2xl outline-none">
          Edit app
        </h1>
      </div>
      {app.data ? (
        <div className={arrived ? FADE_IN : undefined}>
          <AppForm
            mode="edit"
            namespaces={capabilities.data?.namespaces ?? [namespace]}
            appsDomain={appsDomain}
            idleDefaultMinutes={capabilities.data?.idleTimeoutMinutes ?? 0}
            imageRegistries={capabilities.data?.imageRegistries ?? []}
            appsScheme={appsScheme}
            initial={app.data}
            submitting={save.isPending}
            onSubmit={(payload) => save.mutate(payload)}
            onCancel={() => void navigate(back)}
          />
        </div>
      ) : (
        <AppFormSkeleton
          actions={
            <>
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                onClick={() => void navigate(back)}
              >
                Cancel
              </Button>
              <Button className="w-full sm:w-auto" disabled>
                Save changes
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
