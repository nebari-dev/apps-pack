import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2, UploadCloud } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getConfig } from '@/lib/auth';
import { api } from '@/lib/api';
import type { AppCreate, EnvVar } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Switch } from '@/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/ui/tabs';

const SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

type SourceTab = 'upload' | 'git';

export function LaunchPage() {
  const navigate = useNavigate();
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities });

  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [namespace, setNamespace] = useState('');
  const [sourceTab, setSourceTab] = useState<SourceTab>('upload');

  // Sources
  const [file, setFile] = useState<File | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('main');
  const [gitSubdir, setGitSubdir] = useState('');

  // Runtime + access
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [replicas, setReplicas] = useState(1);
  const [cpu, setCpu] = useState('');
  const [memory, setMemory] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [groups, setGroups] = useState('');
  const [subdomain, setSubdomain] = useState('');

  const appsDomain = capabilities.data?.appsDomain || getConfig().appsDomain;
  const appsScheme = getConfig().appsScheme ?? 'https';
  const namespaces = capabilities.data?.namespaces ?? [];
  if (!namespace && namespaces.length > 0) {
    setNamespace(namespaces[0]);
  }

  const activeTab = sourceTab;

  const validationError = useMemo(() => {
    if (!name) return 'Give the app a name.';
    if (!SUBDOMAIN_RE.test(name)) return 'Name must be lowercase letters, digits, and hyphens.';
    if (!displayName) return 'Give the app a display name.';
    if (!namespace) return 'Pick a namespace.';
    if (!subdomain) return 'Pick a subdomain.';
    if (!SUBDOMAIN_RE.test(subdomain)) return 'Subdomain must be lowercase letters, digits, and hyphens.';
    if (activeTab === 'upload' && !file) return 'Choose a .zip or .html file to upload.';
    if (activeTab === 'git' && !gitUrl) return 'Enter the git repository URL.';
    return '';
  }, [name, displayName, namespace, subdomain, activeTab, file, gitUrl]);

  const launch = useMutation({
    mutationFn: async () => {
      const base = {
        name,
        namespace,
        displayName,
        description: description || undefined,
        runtime: {
          replicas,
          env: envVars.filter((e) => e.name),
          resources:
            cpu || memory
              ? { requests: { cpu: cpu || undefined, memory: memory || undefined } }
              : undefined,
        },
        access: {
          public: isPublic,
          groups: groups
            .split(',')
            .map((g) => g.trim())
            .filter(Boolean),
          subdomain,
        },
      };

      if (activeTab === 'upload') {
        if (!file) throw new Error('no file selected');
        return api.uploadApp(base, file);
      }

      const source: AppCreate['source'] = {
        type: 'git',
        git: { url: gitUrl, ref: gitRef || 'main', subdir: gitSubdir || undefined },
      };
      return api.createApp({ ...base, source } as AppCreate);
    },
    onSuccess: (app) => void navigate(`/apps/${app.namespace}/${app.name}`),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="font-semibold text-2xl">Launch an app</h1>
        <p className="text-muted-foreground text-sm">
          Deploys behind the cluster gateway{isPublic ? '' : ' with Keycloak SSO'} at{' '}
          <span className="font-mono">
            {appsScheme}://{subdomain || '<subdomain>'}.{appsDomain}
          </span>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="sales-dashboard"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!subdomain || subdomain === name) setSubdomain(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Display name</Label>
            <Input
              id="displayName"
              placeholder="Sales Dashboard"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              placeholder="Optional short description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Namespace</Label>
            <Select value={namespace} onValueChange={(v) => setNamespace(v as string)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {namespaces.map((ns) => (
                  <SelectItem key={ns} value={ns}>
                    {ns}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source</CardTitle>
          <CardDescription>
            Upload files directly or point at a git repository.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={(v) => setSourceTab(v as SourceTab)}>
            <TabsList>
              <TabsTab value="upload">Upload</TabsTab>
              <TabsTab value="git">Git</TabsTab>
            </TabsList>

            <TabsPanel value="upload" className="mt-4">
              <label
                htmlFor="file-upload"
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border border-dashed p-8 text-center hover:bg-accent"
              >
                <UploadCloud className="size-6 text-muted-foreground" />
                {file ? (
                  <p className="font-medium text-sm">{file.name}</p>
                ) : (
                  <>
                    <p className="font-medium text-sm">Drop a .zip of your site, or a single .html file</p>
                    <p className="text-muted-foreground text-xs">
                      Needs an index.html at the root · text assets only · up to ~900KB
                    </p>
                  </>
                )}
                <input
                  id="file-upload"
                  type="file"
                  accept=".zip,.html,.htm"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </TabsPanel>

            <TabsPanel value="git" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-3">
                <Label htmlFor="gitUrl">Repository URL</Label>
                <Input
                  id="gitUrl"
                  placeholder="https://github.com/org/site"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gitRef">Branch / tag</Label>
                <Input id="gitRef" value={gitRef} onChange={(e) => setGitRef(e.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="gitSubdir">Subdirectory</Label>
                <Input
                  id="gitSubdir"
                  placeholder="e.g. public (optional)"
                  value={gitSubdir}
                  onChange={(e) => setGitSubdir(e.target.value)}
                />
              </div>
            </TabsPanel>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runtime</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="replicas">Replicas</Label>
              <Input
                id="replicas"
                type="number"
                min={0}
                max={10}
                value={replicas}
                onChange={(e) => setReplicas(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cpu">CPU request</Label>
              <Input id="cpu" placeholder="e.g. 250m" value={cpu} onChange={(e) => setCpu(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memory">Memory request</Label>
              <Input
                id="memory"
                placeholder="e.g. 512Mi"
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Environment variables</Label>
            {envVars.map((env, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="NAME"
                  className="font-mono"
                  value={env.name}
                  onChange={(e) =>
                    setEnvVars(envVars.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)))
                  }
                />
                <Input
                  placeholder="value"
                  className="font-mono"
                  value={env.value}
                  onChange={(e) =>
                    setEnvVars(envVars.map((v, j) => (j === i ? { ...v, value: e.target.value } : v)))
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setEnvVars([...envVars, { name: '', value: '' }])}>
              <Plus /> Add variable
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Access</CardTitle>
          <CardDescription>
            Apps are served behind the shared gateway. Private apps get Keycloak SSO enforced at
            the gateway - the app itself needs no auth code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="font-medium text-sm">Public app</p>
              <p className="text-muted-foreground text-xs">
                Anyone with the URL can use it - no login required.
              </p>
            </div>
            <Switch checked={isPublic} onCheckedChange={setIsPublic} />
          </div>
          {!isPublic ? (
            <div className="space-y-1.5">
              <Label htmlFor="groups">Allowed groups</Label>
              <Input
                id="groups"
                placeholder="comma-separated, empty = any signed-in user"
                value={groups}
                onChange={(e) => setGroups(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="subdomain">Subdomain</Label>
            <div className="flex items-center gap-2">
              <Input
                id="subdomain"
                className="max-w-56 font-mono"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
              />
              <span className="text-muted-foreground text-sm">.{appsDomain}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {launch.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Launch failed</AlertTitle>
          <AlertDescription>
            {launch.error instanceof Error ? launch.error.message : String(launch.error)}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        {validationError ? <p className="text-muted-foreground text-sm">{validationError}</p> : null}
        <Button size="lg" disabled={!!validationError} loading={launch.isPending} onClick={() => launch.mutate()}>
          Launch app
        </Button>
      </div>
    </div>
  );
}
