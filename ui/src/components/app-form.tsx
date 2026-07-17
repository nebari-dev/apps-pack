import { Plus, Trash2, UploadCloud } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { App, AppCreate, AppPatch, AppSource, EnvVar } from '@/lib/types';
import { Button } from '@/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Switch } from '@/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/ui/tabs';

const SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Source authoring tabs. "keep" is edit-only: leave the current source as-is. */
type SourceTab = 'upload' | 'git' | 'pvc' | 'keep';

/** What the app is: a static site served by nginx, or a Python/pixi service. */
type AppKind = 'static' | 'pixi';

/** Resource presets that fill both requests and limits in one click. */
const PRESETS: Record<string, { cpuReq: string; memReq: string; cpuLim: string; memLim: string }> = {
  Small: { cpuReq: '100m', memReq: '128Mi', cpuLim: '250m', memLim: '256Mi' },
  Medium: { cpuReq: '250m', memReq: '512Mi', cpuLim: '500m', memLim: '1Gi' },
  Large: { cpuReq: '500m', memReq: '1Gi', cpuLim: '1', memLim: '2Gi' },
};

export type SubmitPayload =
  | { kind: 'create'; body: AppCreate }
  | { kind: 'upload'; manifest: Omit<AppCreate, 'source'>; file: File }
  | { kind: 'patch'; body: AppPatch };

export interface AppFormProps {
  mode: 'create' | 'edit';
  namespaces: string[];
  appsDomain: string;
  appsScheme: string;
  initial?: App;
  submitting: boolean;
  onSubmit: (payload: SubmitPayload) => void;
}

export function AppForm({
  mode,
  namespaces,
  appsDomain,
  appsScheme,
  initial,
  submitting,
  onSubmit,
}: AppFormProps) {
  const isEdit = mode === 'edit';
  const res = initial?.runtime?.resources;

  const [name] = useState(initial?.name ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [thumbnail, setThumbnail] = useState(initial?.thumbnail ?? '');
  const [namespace, setNamespace] = useState(initial?.namespace ?? '');

  const [sourceTab, setSourceTab] = useState<SourceTab>(isEdit ? 'keep' : 'upload');
  const [nameInput, setNameInput] = useState(initial?.name ?? '');

  // App kind: presence of a pixi task is the wire discriminator.
  const [kind, setKind] = useState<AppKind>(initial?.runtime?.pixiTask ? 'pixi' : 'static');
  const [pixiTask, setPixiTask] = useState(initial?.runtime?.pixiTask ?? '');

  // Sources
  const [file, setFile] = useState<File | null>(null);
  const [gitUrl, setGitUrl] = useState(initial?.source?.git?.url ?? '');
  const [gitRef, setGitRef] = useState(initial?.source?.git?.ref ?? 'main');
  const [gitSubdir, setGitSubdir] = useState(initial?.source?.git?.subdir ?? '');
  const [pvcClaim, setPvcClaim] = useState(initial?.source?.pvc?.claimName ?? '');
  const [pvcSubPath, setPvcSubPath] = useState(initial?.source?.pvc?.subPath ?? '');

  // Runtime + access
  const [envVars, setEnvVars] = useState<EnvVar[]>(initial?.runtime?.env ?? []);
  const [replicas, setReplicas] = useState(initial?.runtime?.replicas ?? 1);
  const [cpuReq, setCpuReq] = useState(res?.requests?.cpu ?? '');
  const [memReq, setMemReq] = useState(res?.requests?.memory ?? '');
  const [cpuLim, setCpuLim] = useState(res?.limits?.cpu ?? '');
  const [memLim, setMemLim] = useState(res?.limits?.memory ?? '');
  const [isPublic, setIsPublic] = useState(initial?.access?.public ?? false);
  const [groups, setGroups] = useState((initial?.access?.groups ?? []).join(', '));
  const [subdomain, setSubdomain] = useState(initial?.access?.subdomain ?? '');

  if (!isEdit && !namespace && namespaces.length > 0) setNamespace(namespaces[0]);

  const effectiveName = isEdit ? name : nameInput;

  const validationError = useMemo(() => {
    if (!isEdit) {
      if (!nameInput) return 'Give the app a name.';
      if (!SUBDOMAIN_RE.test(nameInput)) return 'Name must be lowercase letters, digits, and hyphens.';
      if (!subdomain) return 'Pick a subdomain.';
      if (!SUBDOMAIN_RE.test(subdomain)) return 'Subdomain must be lowercase letters, digits, and hyphens.';
    }
    if (!displayName) return 'Give the app a display name.';
    if (!namespace) return 'Pick a namespace.';
    if (kind === 'pixi' && !pixiTask) return 'Enter the pixi task that launches the app.';
    if (sourceTab === 'upload' && !file) {
      return kind === 'pixi' ? 'Choose a .zip of your pixi project to upload.' : 'Choose a .zip or .html file to upload.';
    }
    if (kind === 'pixi' && sourceTab === 'upload' && file && !file.name.toLowerCase().endsWith('.zip')) {
      return 'Pixi apps must be uploaded as a .zip archive.';
    }
    if (sourceTab === 'git' && !gitUrl) return 'Enter the git repository URL.';
    if (sourceTab === 'pvc' && !pvcClaim) return 'Enter the PVC claim name.';
    return '';
  }, [isEdit, nameInput, displayName, namespace, subdomain, kind, pixiTask, sourceTab, file, gitUrl, pvcClaim]);

  const applyPreset = (preset: keyof typeof PRESETS) => {
    const p = PRESETS[preset];
    setCpuReq(p.cpuReq);
    setMemReq(p.memReq);
    setCpuLim(p.cpuLim);
    setMemLim(p.memLim);
  };

  const buildResources = () => {
    const requests = cpuReq || memReq ? { cpu: cpuReq || undefined, memory: memReq || undefined } : undefined;
    const limits = cpuLim || memLim ? { cpu: cpuLim || undefined, memory: memLim || undefined } : undefined;
    return requests || limits ? { requests, limits } : undefined;
  };

  const buildSource = (): AppSource | undefined => {
    if (sourceTab === 'git') return { type: 'git', git: { url: gitUrl, ref: gitRef || 'main', subdir: gitSubdir || undefined } };
    if (sourceTab === 'pvc') return { type: 'pvc', pvc: { claimName: pvcClaim, subPath: pvcSubPath || undefined } };
    return undefined; // 'upload' handled separately; 'keep' leaves source untouched
  };

  const handleSubmit = () => {
    if (validationError) return;
    const runtime = {
      replicas,
      env: envVars.filter((e) => e.name),
      resources: buildResources(),
      pixiTask: kind === 'pixi' ? pixiTask : '',
    };

    if (isEdit) {
      const body: AppPatch = {
        displayName,
        description,
        thumbnail,
        runtime,
        access: {
          public: isPublic,
          groups: splitGroups(groups),
          subdomain: initial?.access?.subdomain ?? subdomain,
        },
      };
      const source = buildSource();
      if (source) body.source = source;
      onSubmit({ kind: 'patch', body });
      return;
    }

    const base = {
      name: nameInput,
      namespace,
      displayName,
      description: description || undefined,
      thumbnail: thumbnail || undefined,
      runtime,
      access: { public: isPublic, groups: splitGroups(groups), subdomain },
    };

    if (sourceTab === 'upload') {
      if (!file) return;
      onSubmit({ kind: 'upload', manifest: base, file });
      return;
    }
    onSubmit({ kind: 'create', body: { ...base, source: buildSource() } as AppCreate });
  };

  return (
    <div className="max-w-3xl space-y-6">
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
              value={effectiveName}
              disabled={isEdit}
              onChange={(e) => {
                setNameInput(e.target.value);
                if (!subdomain || subdomain === nameInput) setSubdomain(e.target.value);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Display name</Label>
            <Input id="displayName" placeholder="Sales Dashboard" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="description">Description</Label>
            <Input id="description" placeholder="Optional short description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="thumbnail">Thumbnail URL</Label>
            <Input id="thumbnail" placeholder="https://…/icon.png (optional)" value={thumbnail} onChange={(e) => setThumbnail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Namespace</Label>
            <Select value={namespace} onValueChange={(v) => setNamespace(v as string)} disabled={isEdit}>
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
          <div className="space-y-1.5">
            <Label>App type</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as AppKind)}
              items={{ static: 'Static site (HTML/CSS/JS)', pixi: 'Python app (pixi)' }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="static">Static site (HTML/CSS/JS)</SelectItem>
                <SelectItem value="pixi">Python app (pixi)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === 'pixi' ? (
            <div className="space-y-1.5">
              <Label htmlFor="pixiTask">Launch task</Label>
              <Input
                id="pixiTask"
                className="font-mono"
                placeholder="start"
                value={pixiTask}
                onChange={(e) => setPixiTask(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Runs <span className="font-mono">pixi run {pixiTask || '<task>'}</span>; the task must serve on{' '}
                <span className="font-mono">0.0.0.0:8080</span>.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source</CardTitle>
          <CardDescription>
            {isEdit
              ? 'Keep the current source, or point the app at a new one.'
              : 'Upload files directly, point at a git repository, or mount a PVC.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={sourceTab} onValueChange={(v) => setSourceTab(v as SourceTab)}>
            <TabsList>
              {isEdit ? <TabsTab value="keep">Keep current</TabsTab> : <TabsTab value="upload">Upload</TabsTab>}
              <TabsTab value="git">Git</TabsTab>
              <TabsTab value="pvc">PVC</TabsTab>
            </TabsList>

            {isEdit ? (
              <TabsPanel value="keep" className="mt-4">
                <p className="text-muted-foreground text-sm">
                  Current source: <span className="font-mono">{initial?.source?.type ?? 'unknown'}</span>. Uploaded
                  (inline) content can't be edited here — switch to Git or PVC, or relaunch to replace files.
                </p>
              </TabsPanel>
            ) : (
              <TabsPanel value="upload" className="mt-4">
                <label
                  htmlFor="file-upload"
                  className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border border-dashed p-8 text-center hover:bg-accent"
                >
                  <UploadCloud className="size-6 text-muted-foreground" />
                  {file ? (
                    <p className="font-medium text-sm">{file.name}</p>
                  ) : kind === 'pixi' ? (
                    <>
                      <p className="font-medium text-sm">Drop a .zip of your pixi project</p>
                      <p className="text-muted-foreground text-xs">
                        Needs a pixi.toml (or pyproject.toml) at the root · text files only · up to ~900KB
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-sm">Drop a .zip of your site, or a single .html file</p>
                      <p className="text-muted-foreground text-xs">Needs an index.html at the root · text assets only · up to ~900KB</p>
                    </>
                  )}
                  <input
                    id="file-upload"
                    type="file"
                    accept={kind === 'pixi' ? '.zip' : '.zip,.html,.htm'}
                    className="hidden"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </TabsPanel>
            )}

            <TabsPanel value="git" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-3">
                <Label htmlFor="gitUrl">Repository URL</Label>
                <Input id="gitUrl" placeholder="https://github.com/org/site" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gitRef">Branch / tag</Label>
                <Input id="gitRef" value={gitRef} onChange={(e) => setGitRef(e.target.value)} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="gitSubdir">Subdirectory</Label>
                <Input id="gitSubdir" placeholder="e.g. public (optional)" value={gitSubdir} onChange={(e) => setGitSubdir(e.target.value)} />
              </div>
            </TabsPanel>

            <TabsPanel value="pvc" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="pvcClaim">Claim name</Label>
                <Input id="pvcClaim" placeholder="shared-sites" value={pvcClaim} onChange={(e) => setPvcClaim(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pvcSubPath">Sub-path</Label>
                <Input id="pvcSubPath" placeholder="site/ (optional)" value={pvcSubPath} onChange={(e) => setPvcSubPath(e.target.value)} />
              </div>
            </TabsPanel>
          </Tabs>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runtime</CardTitle>
          <CardDescription>Presets fill requests and limits; tweak any field afterwards.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-sm">Preset:</span>
            {Object.keys(PRESETS).map((p) => (
              <Button key={p} type="button" variant="outline" size="sm" onClick={() => applyPreset(p as keyof typeof PRESETS)}>
                {p}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="replicas">Replicas</Label>
              <Input id="replicas" type="number" min={0} max={10} value={replicas} onChange={(e) => setReplicas(Number(e.target.value))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="cpuReq">CPU request</Label>
              <Input id="cpuReq" placeholder="250m" value={cpuReq} onChange={(e) => setCpuReq(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memReq">Memory request</Label>
              <Input id="memReq" placeholder="512Mi" value={memReq} onChange={(e) => setMemReq(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cpuLim">CPU limit</Label>
              <Input id="cpuLim" placeholder="500m" value={cpuLim} onChange={(e) => setCpuLim(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="memLim">Memory limit</Label>
              <Input id="memLim" placeholder="1Gi" value={memLim} onChange={(e) => setMemLim(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-col items-start gap-2">
            <Label>Environment variables</Label>
            {envVars.map((env, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
              <div key={i} className="flex w-full items-center gap-2">
                <Input placeholder="NAME" className="font-mono" value={env.name} onChange={(e) => setEnvVars(envVars.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)))} />
                <Input placeholder="value" className="font-mono" value={env.value} onChange={(e) => setEnvVars(envVars.map((v, j) => (j === i ? { ...v, value: e.target.value } : v)))} />
                <Button variant="ghost" size="icon-sm" onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}>
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
            Apps are served behind the shared gateway. Private apps get Keycloak SSO enforced at the gateway - the
            app itself needs no auth code.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <p className="font-medium text-sm">Public app</p>
              <p className="text-muted-foreground text-xs">Anyone with the URL can use it - no login required.</p>
            </div>
            <Switch checked={isPublic} onCheckedChange={setIsPublic} />
          </div>
          {!isPublic ? (
            <div className="space-y-1.5">
              <Label htmlFor="groups">Allowed groups</Label>
              <Input id="groups" placeholder="comma-separated, empty = any signed-in user" value={groups} onChange={(e) => setGroups(e.target.value)} />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="subdomain">Subdomain</Label>
            <div className="flex items-center gap-2">
              <Input id="subdomain" className="max-w-56 font-mono" value={subdomain} disabled={isEdit} onChange={(e) => setSubdomain(e.target.value)} />
              <span className="text-muted-foreground text-sm">.{appsDomain}</span>
            </div>
            {isEdit ? <p className="text-muted-foreground text-xs">Subdomain is fixed after launch.</p> : null}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {validationError ? <p className="text-muted-foreground text-sm">{validationError}</p> : null}
        <p className="mr-auto text-muted-foreground text-sm">
          {appsScheme}://{(isEdit ? initial?.access?.subdomain : subdomain) || '<subdomain>'}.{appsDomain}
        </p>
        <Button size="lg" disabled={!!validationError} loading={submitting} onClick={handleSubmit}>
          {isEdit ? 'Save changes' : 'Launch app'}
        </Button>
      </div>
    </div>
  );
}

function splitGroups(raw: string): string[] {
  return raw
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}
