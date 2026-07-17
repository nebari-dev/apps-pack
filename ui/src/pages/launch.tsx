import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AppForm, type SubmitPayload } from '@/components/app-form';
import { api } from '@/lib/api';
import { getConfig } from '@/lib/auth';
import type { AppCreate } from '@/lib/types';
import { toast } from '@/ui/toast';

export function LaunchPage() {
  const navigate = useNavigate();
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  const appsDomain = capabilities.data?.appsDomain || getConfig().appsDomain;
  const appsScheme = getConfig().appsScheme ?? 'https';
  const namespaces = capabilities.data?.namespaces ?? [];

  const launch = useMutation({
    mutationFn: (payload: SubmitPayload) => {
      if (payload.kind === 'upload') return api.uploadApp(payload.manifest, payload.file);
      if (payload.kind === 'create') return api.createApp(payload.body as AppCreate);
      throw new Error('unexpected payload for launch');
    },
    onSuccess: (app) => {
      toast.success(
        `Launched ${app.displayName || app.name}`,
        'Deploying now — status will update on the app page.',
      );
      void navigate(`/apps/${app.namespace}/${app.name}`);
    },
    onError: (err) => toast.error('Launch failed', err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-2xl">Launch an app</h1>
        <p className="text-muted-foreground text-sm">Deploy a static site or Python app behind the cluster gateway.</p>
      </div>
      <AppForm
        mode="create"
        namespaces={namespaces}
        appsDomain={appsDomain}
        appsScheme={appsScheme}
        submitting={launch.isPending}
        onSubmit={(payload) => launch.mutate(payload)}
      />
    </div>
  );
}
