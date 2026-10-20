import { ChevronDown, Info, Lock, Plus, Trash2, UploadCloud } from "lucide-react";
import type { Dispatch, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { App } from "@/lib/types";
import {
  type AppKind,
  describeValueFrom,
  type Field,
  type FormAction,
  type FormState,
  LANDING_PAGE_LOCKED,
  PRESETS,
  type Preset,
  type SourceTab,
} from "./state";

/** The DOM id of the control each validated field renders, for moving focus. */
export const CONTROL_IDS: Record<Field, string> = {
  name: "name",
  displayName: "displayName",
  namespace: "namespace",
  pixiTask: "pixiTask",
  file: "file-upload",
  gitUrl: "gitUrl",
  pvcClaim: "pvcClaim",
  subdomain: "subdomain",
};

/** What a validated control spreads: its invalid state, description and blur handler. */
export interface FieldProps {
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  onBlur: () => void;
}

/** What every section needs from the form. */
export interface FormContext {
  state: FormState;
  set: <K extends keyof FormState>(field: K, value: FormState[K]) => void;
  dispatch: Dispatch<FormAction>;
  /** Props for a validated control; `helpId` keeps its help text in the description. */
  fieldProps: (field: Field, helpId?: string) => FieldProps;
  /** The message to show under a control, once it is touched or the form was submitted. */
  errorFor: (field: Field) => string | undefined;
  isEdit: boolean;
  initial?: App;
  namespaces: string[];
  appsDomain: string;
}

/** The message under a control; its id is what the control's aria-describedby names. */
function FieldError({ form, field }: { form: FormContext; field: Field }) {
  const message = form.errorFor(field);
  return message ? (
    <p id={`${field}-error`} className="text-destructive-foreground text-sm">
      {message}
    </p>
  ) : null;
}

/** An info button that explains a term on hover or focus. */
function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className="text-muted-foreground"
          >
            <Info aria-hidden="true" />
          </Button>
        }
      />
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
}

/** A lock beside a label whose control cannot change after launch. */
function FixedAfterLaunch() {
  return (
    <span title="Fixed after launch" className="inline-flex text-muted-foreground">
      <Lock aria-hidden="true" className="size-3.5" />
      <span className="sr-only">Fixed after launch</span>
    </span>
  );
}

/** Name, display name, namespace and what kind of app it is. */
export function BasicsSection({ form }: { form: FormContext }) {
  const { nameInput, displayName, description, thumbnail, namespace, kind, pixiTask } = form.state;
  const { set, dispatch, fieldProps, isEdit, namespaces } = form;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Basics</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="name">Name</Label>
            {isEdit ? <FixedAfterLaunch /> : null}
          </div>
          <Input
            id="name"
            {...fieldProps("name", isEdit ? undefined : "name-help")}
            placeholder="sales-dashboard"
            value={nameInput}
            disabled={isEdit}
            onChange={(e) => dispatch({ type: "name", value: e.target.value })}
          />
          {isEdit ? null : (
            <p id="name-help" className="text-muted-foreground text-xs">
              Lowercase letters, digits and hyphens. Also used as the default subdomain.
            </p>
          )}
          <FieldError form={form} field="name" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="displayName">Display name</Label>
          <Input
            id="displayName"
            {...fieldProps("displayName")}
            placeholder="Sales Dashboard"
            value={displayName}
            onChange={(e) => set("displayName", e.target.value)}
          />
          <FieldError form={form} field="displayName" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Input
            id="description"
            placeholder="Optional short description"
            value={description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="thumbnail">Thumbnail URL</Label>
          <Input
            id="thumbnail"
            placeholder="https://…/icon.png (optional)"
            value={thumbnail}
            onChange={(e) => set("thumbnail", e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label id="namespace-label">Namespace</Label>
            {isEdit ? <FixedAfterLaunch /> : null}
          </div>
          <Select
            value={namespace}
            onValueChange={(v) => set("namespace", v as string)}
            disabled={isEdit}
          >
            <SelectTrigger
              id="namespace"
              aria-labelledby="namespace-label"
              {...fieldProps("namespace")}
            >
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
          <FieldError form={form} field="namespace" />
        </div>
        <div className="space-y-1.5">
          <Label id="kind-label">App type</Label>
          <Select
            value={kind}
            onValueChange={(v) => set("kind", v as AppKind)}
            items={{ static: "Static site (HTML/CSS/JS)", pixi: "Python app (pixi)" }}
          >
            <SelectTrigger aria-labelledby="kind-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="static">Static site (HTML/CSS/JS)</SelectItem>
              <SelectItem value="pixi">Python app (pixi)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {kind === "pixi" ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <Label htmlFor="pixiTask">Launch task</Label>
              <InfoTip label="About Launch task">
                A task defined in your pixi.toml. The app starts with{" "}
                <span className="font-mono">pixi run {pixiTask || "<task>"}</span>.
              </InfoTip>
            </div>
            <Input
              id="pixiTask"
              {...fieldProps("pixiTask", "pixiTask-help")}
              className="font-mono"
              placeholder="start"
              value={pixiTask}
              onChange={(e) => set("pixiTask", e.target.value)}
            />
            <p id="pixiTask-help" className="text-muted-foreground text-xs">
              The pixi task that starts your server.
            </p>
            <FieldError form={form} field="pixiTask" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The current source of an App being edited: repo and ref, claim and path, or uploaded files. */
function CurrentSource({ app }: { app?: App }) {
  const source = app?.source;
  const rows: [string, string][] = [];
  if (source?.type === "git" && source.git) {
    rows.push(["Repository", source.git.url], ["Branch / tag", source.git.ref || "main"]);
    if (source.git.subdir) rows.push(["Subdirectory", source.git.subdir]);
  } else if (source?.type === "pvc" && source.pvc) {
    rows.push(["Claim name", source.pvc.claimName]);
    if (source.pvc.subPath) rows.push(["Sub-path", source.pvc.subPath]);
  }
  if (rows.length === 0) {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">
          {source?.type === "inline" ? "Uploaded files" : (source?.type ?? "Unknown source")}
        </p>
        <p className="text-muted-foreground">
          Uploaded content can't be edited here. Switch to Git or Volume (PVC), or relaunch to
          replace the files.
        </p>
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Where the content comes from: an upload, git or a PVC (or, on an edit, unchanged). */
export function SourceSection({ form }: { form: FormContext }) {
  const { sourceTab, kind, file, gitUrl, gitRef, gitSubdir, pvcClaim, pvcSubPath } = form.state;
  const { set, fieldProps, isEdit, initial } = form;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Source</CardTitle>
        <CardDescription>
          {isEdit
            ? "Keep the current source, or point the app at a new one."
            : "Upload files directly, point at a git repository, or mount a volume."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={sourceTab} onValueChange={(v) => set("sourceTab", v as SourceTab)}>
          <div className="flex flex-wrap items-center gap-1">
            <TabsList>
              {isEdit ? (
                <TabsTab value="keep">Keep current</TabsTab>
              ) : (
                <TabsTab value="upload">Upload</TabsTab>
              )}
              <TabsTab value="git">Git</TabsTab>
              <TabsTab value="pvc">Volume (PVC)</TabsTab>
            </TabsList>
            <InfoTip label="About PVC">
              A PersistentVolumeClaim: an existing Kubernetes storage volume in the app's namespace.
              The app serves the files on it.
            </InfoTip>
          </div>

          {isEdit ? (
            <TabsPanel value="keep" className="mt-4">
              <CurrentSource app={initial} />
            </TabsPanel>
          ) : (
            <TabsPanel value="upload" className="mt-4 space-y-1.5">
              <label
                htmlFor="file-upload"
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border border-dashed p-8 text-center hover:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-ring"
              >
                <UploadCloud className="size-6 text-muted-foreground" />
                {file ? (
                  <p className="font-medium text-sm">{file.name}</p>
                ) : kind === "pixi" ? (
                  <>
                    <p className="font-medium text-sm">Drop a .zip of your pixi project</p>
                    <p className="text-muted-foreground text-xs">
                      Needs a pixi.toml (or pyproject.toml) at the root · text files only · up to
                      ~900KB
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium text-sm">
                      Drop a .zip of your site, or a single .html file
                    </p>
                    <p className="text-muted-foreground text-xs">
                      Needs an index.html at the root · text assets only · up to ~900KB
                    </p>
                  </>
                )}
                <input
                  id="file-upload"
                  {...fieldProps("file")}
                  type="file"
                  accept={kind === "pixi" ? ".zip" : ".zip,.html,.htm"}
                  // Visually hidden, not display:none, so it stays in the tab
                  // order; the drop zone shows its focus ring.
                  className="sr-only"
                  onChange={(e) => set("file", e.target.files?.[0] ?? null)}
                />
              </label>
              <FieldError form={form} field="file" />
            </TabsPanel>
          )}

          <TabsPanel value="git" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="gitUrl">Repository URL</Label>
              <Input
                id="gitUrl"
                {...fieldProps("gitUrl")}
                placeholder="https://github.com/org/site"
                value={gitUrl}
                onChange={(e) => set("gitUrl", e.target.value)}
              />
              <FieldError form={form} field="gitUrl" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gitRef">Branch / tag</Label>
              <Input id="gitRef" value={gitRef} onChange={(e) => set("gitRef", e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="gitSubdir">Subdirectory</Label>
              <Input
                id="gitSubdir"
                placeholder="e.g. public (optional)"
                value={gitSubdir}
                onChange={(e) => set("gitSubdir", e.target.value)}
              />
            </div>
          </TabsPanel>

          <TabsPanel value="pvc" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pvcClaim">Claim name</Label>
              <Input
                id="pvcClaim"
                {...fieldProps("pvcClaim")}
                placeholder="shared-sites"
                value={pvcClaim}
                onChange={(e) => set("pvcClaim", e.target.value)}
              />
              <FieldError form={form} field="pvcClaim" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pvcSubPath">Sub-path</Label>
              <Input
                id="pvcSubPath"
                placeholder="site/ (optional)"
                value={pvcSubPath}
                onChange={(e) => set("pvcSubPath", e.target.value)}
              />
            </div>
          </TabsPanel>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** True when the App runs with anything but the defaults: one replica and no resources. */
function hasCustomRuntime(app?: App): boolean {
  const runtime = app?.runtime;
  const res = runtime?.resources;
  const amounts = { ...res?.requests, ...res?.limits };
  return (runtime?.replicas ?? 1) !== 1 || Object.keys(amounts).length > 0;
}

/** Environment variables, with replicas, resources and the port rule under Advanced. */
export function RuntimeSection({ form }: { form: FormContext }) {
  const { replicas, cpuReq, memReq, cpuLim, memLim, envVars } = form.state;
  const { set, dispatch, isEdit, initial } = form;
  const activePreset = (Object.keys(PRESETS) as Preset[]).find((p) => {
    const v = PRESETS[p];
    return v.cpuReq === cpuReq && v.memReq === memReq && v.cpuLim === cpuLim && v.memLim === memLim;
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime</CardTitle>
        <CardDescription>
          Environment variables. Replicas and resources are under Advanced; presets fill requests
          and limits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset className="flex flex-col items-start gap-2">
          <legend className="mb-2 font-medium text-sm leading-none">Environment variables</legend>
          {envVars.map((env, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
            <div key={i} className="flex w-full items-center gap-2">
              <Input
                aria-label={`Variable ${i + 1} name`}
                placeholder="NAME"
                className="font-mono"
                value={env.name}
                onChange={(e) =>
                  set(
                    "envVars",
                    envVars.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)),
                  )
                }
              />
              <Input
                aria-label={`Value of ${env.name || `variable ${i + 1}`}`}
                placeholder="value"
                className="font-mono"
                // A valueFrom reference (set with kubectl) is kept but not editable here.
                value={env.valueFrom ? describeValueFrom(env.valueFrom) : (env.value ?? "")}
                disabled={Boolean(env.valueFrom)}
                onChange={(e) =>
                  set(
                    "envVars",
                    envVars.map((v, j) => (j === i ? { ...v, value: e.target.value } : v)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${env.name || `variable ${i + 1}`}`}
                onClick={() =>
                  set(
                    "envVars",
                    envVars.filter((_, j) => j !== i),
                  )
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => set("envVars", [...envVars, { name: "", value: "" }])}
          >
            <Plus /> Add variable
          </Button>
        </fieldset>

        <details
          className="group rounded-md border border-border"
          // An edit opens it when the App runs with non-default replicas or resources.
          open={isEdit && hasCustomRuntime(initial)}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 font-medium text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            Advanced
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted-foreground motion-safe:transition-transform motion-safe:duration-(--duration-fast) group-open:rotate-180"
            />
          </summary>
          <div className="space-y-4 border-border border-t px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm">Preset:</span>
              {(Object.keys(PRESETS) as Preset[]).map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={p === activePreset ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={p === activePreset}
                  onClick={() => dispatch({ type: "preset", preset: p })}
                >
                  {p}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="replicas">Replicas</Label>
                <Input
                  id="replicas"
                  type="number"
                  min={0}
                  max={10}
                  value={replicas}
                  onChange={(e) => set("replicas", Number(e.target.value))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="cpuReq">CPU request</Label>
                <Input
                  id="cpuReq"
                  placeholder="250m"
                  value={cpuReq}
                  onChange={(e) => set("cpuReq", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="memReq">Memory request</Label>
                <Input
                  id="memReq"
                  placeholder="512Mi"
                  value={memReq}
                  onChange={(e) => set("memReq", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cpuLim">CPU limit</Label>
                <Input
                  id="cpuLim"
                  placeholder="500m"
                  value={cpuLim}
                  onChange={(e) => set("cpuLim", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="memLim">Memory limit</Label>
                <Input
                  id="memLim"
                  placeholder="1Gi"
                  value={memLim}
                  onChange={(e) => set("memLim", e.target.value)}
                />
              </div>
            </div>
            <p className="text-muted-foreground-strong text-sm">
              Python apps must serve on <span className="font-mono">0.0.0.0:$PORT</span> (8080, or
              8081 when groups or users restrict the app).
            </p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

/** Public or signed-in access, who may open it, the subdomain, and the landing-page tile. */
export function AccessSection({ form }: { form: FormContext }) {
  const { isPublic, groups, users, subdomain, onLandingPage } = form.state;
  const { set, fieldProps, isEdit, appsDomain } = form;
  const row = "py-4 first:pt-0 last:pb-0";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Access</CardTitle>
        <CardDescription>
          Apps sit behind the shared gateway. Private apps ask for a Keycloak sign-in; the app
          itself needs no auth code.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border">
          <div className={`flex items-center justify-between gap-3 ${row}`}>
            <div>
              <p id="public-label" className="font-medium text-sm">
                Public app
              </p>
              <p id="public-help" className="text-muted-foreground text-xs">
                Anyone with the URL can use it - no login required.
              </p>
            </div>
            <Switch
              checked={isPublic}
              onCheckedChange={(v) => set("isPublic", v)}
              aria-labelledby="public-label"
              aria-describedby="public-help"
            />
          </div>
          {!isPublic ? (
            <div className={`space-y-4 ${row}`}>
              <div className="space-y-1.5">
                <Label htmlFor="groups">Allowed groups</Label>
                <Input
                  id="groups"
                  placeholder="comma-separated"
                  aria-describedby="groups-help"
                  value={groups}
                  onChange={(e) => set("groups", e.target.value)}
                />
                <p id="groups-help" className="text-muted-foreground-strong text-sm">
                  Only members of these Keycloak groups can open the app; everyone else gets 403.
                  Leave groups and users empty to allow any signed-in user. Changes apply when a
                  user's session token refreshes (a few minutes).
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="users">Allowed users</Label>
                <Input
                  id="users"
                  placeholder="comma-separated usernames"
                  aria-describedby="users-help"
                  value={users}
                  onChange={(e) => set("users", e.target.value)}
                />
                <p id="users-help" className="text-muted-foreground-strong text-sm">
                  Keycloak usernames who can open the app even if they are not in an allowed group.
                </p>
              </div>
            </div>
          ) : null}
          <div className={`space-y-1.5 ${row}`}>
            <Label htmlFor="subdomain">Subdomain</Label>
            <div className="flex w-full max-w-md">
              <div className="min-w-0 flex-1">
                <Input
                  id="subdomain"
                  {...fieldProps("subdomain", isEdit ? "subdomain-help" : undefined)}
                  className="rounded-r-none font-mono"
                  value={subdomain}
                  disabled={isEdit}
                  onChange={(e) => set("subdomain", e.target.value)}
                />
              </div>
              <span className="inline-flex max-w-[60%] shrink-0 items-center truncate rounded-r-md border border-border border-l-0 bg-muted px-3 font-mono text-muted-foreground-strong text-sm">
                .{appsDomain}
              </span>
            </div>
            {isEdit ? (
              <p id="subdomain-help" className="text-muted-foreground text-xs">
                Subdomain is fixed after launch.
              </p>
            ) : null}
            <FieldError form={form} field="subdomain" />
          </div>
          {LANDING_PAGE_LOCKED ? (
            <div className={`space-y-1 ${row}`}>
              <p className="font-medium text-sm">Show on the landing page</p>
              <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                {onLandingPage ? "Listed." : "Not listed."} Changing this here is not available yet.
              </p>
            </div>
          ) : (
            <div className={`flex items-center justify-between gap-3 ${row}`}>
              <div>
                <p id="landing-label" className="font-medium text-sm">
                  Show on the landing page
                </p>
                <p id="landing-help" className="text-muted-foreground text-xs">
                  Add a tile for this app to the Nebari landing page. Off by default - the app is
                  reachable at its URL and listed here either way.
                </p>
              </div>
              <Switch
                checked={onLandingPage}
                onCheckedChange={(v) => set("onLandingPage", v)}
                aria-labelledby="landing-label"
                aria-describedby="landing-help"
              />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
