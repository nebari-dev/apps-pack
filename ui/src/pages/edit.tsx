import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppForm, type SubmitPayload } from '@/components/app-form';
import { api } from '@/lib/api';
import { getConfig } from '@/lib/auth';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

export function EditPage() {
  const { namespace = '', name = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const app = useQuery({ queryKey: ['app', namespace, name], queryFn: () => api.getApp(namespace, name) });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  const appsDomain = capabilities.data?.appsDomain || getConfig().appsDomain;
  const appsScheme = getConfig().appsScheme ?? 'https';

  const save = useMutation({
    mutationFn: (payload: SubmitPayload) => {
      if (payload.kind !== 'patch') throw new Error('unexpected payload for edit');
      return api.patchApp(namespace, name, payload.body);
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ['app', namespace, name] });
      void queryClient.invalidateQueries({ queryKey: ['apps'] });
      toast.success(`Saved ${updated.displayName || updated.name}`);
      void navigate(`/apps/${namespace}/${name}`);
    },
    onError: (err) => toast.error('Save failed', err instanceof Error ? err.message : String(err)),
  });

  if (app.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (app.isError || !app.data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load app</AlertTitle>
        <AlertDescription>{String(app.error ?? 'not found')}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/apps/${namespace}/${name}`}
          className="mb-1 inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> {app.data.displayName || app.data.name}
        </Link>
        <h1 className="font-semibold text-2xl">Edit app</h1>
      </div>
      <AppForm
        mode="edit"
        namespaces={capabilities.data?.namespaces ?? [namespace]}
        appsDomain={appsDomain}
        appsScheme={appsScheme}
        initial={app.data}
        submitting={save.isPending}
        onSubmit={(payload) => save.mutate(payload)}
      />
    </div>
  );
}
