import { ChevronDown, Info, Lock, Plus, Trash2, TriangleAlert, UploadCloud } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { App } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  type AppKind,
  canEditManagers,
  describeValueFrom,
  type Field,
  type FormAction,
  type FormState,
  IDLE_MAX,
  IDLE_MIN,
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
  imageRef: "imageRef",
  imagePort: "imagePort",
  imageRunAsUser: "imageRunAsUser",
  idleTimeout: "idleTimeout",
  secrets: "secrets-first",
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
  /** The cluster's default idle timeout in minutes; 0 = apps stay up unless they set one. */
  idleDefaultMinutes: number;
  /** Registries image apps may pull from (from /capabilities); empty = image apps are off. */
  imageRegistries: string[];
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

/** Help text under a control, and the same muted copy elsewhere in the form. */
const HELP = "text-muted-foreground text-sm";

/**
 * One labelled control: a label row of fixed height (whether or not it holds
 * an info tip or a lock), the control, then help text and the error. The fixed
 * row is what keeps controls in the same grid row on one top edge.
 *
 * `id` is the control's id; a control that is not a native input (a select
 * trigger) passes `labelId` instead and names itself with aria-labelledby.
 */
function FormField({
  id,
  labelId,
  label,
  adornment,
  help,
  form,
  className,
  children,
}: {
  id?: string;
  labelId?: string;
  label: string;
  /** An InfoTip or FixedAfterLaunch beside the label. */
  adornment?: ReactNode;
  /** Rendered as `${id}-help`; the control names it in aria-describedby. */
  help?: ReactNode;
  /** Pass for a validated control: its error shows under it. Its id is the Field. */
  form?: FormContext;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex h-5 items-center gap-1.5">
        <Label id={labelId} htmlFor={labelId ? undefined : id}>
          {label}
        </Label>
        {adornment}
      </div>
      {children}
      {help ? (
        <p id={`${id}-help`} className={HELP}>
          {help}
        </p>
      ) : null}
      {form ? <FieldError form={form} field={id as Field} /> : null}
    </div>
  );
}

/** Select triggers share the text inputs' inset and flat surface. */
const SELECT_TRIGGER = "pl-3 shadow-none";

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
            // The button is taller than a label's text; the negative margin
            // keeps it from growing whatever row it sits in.
            className="-my-1.5 text-muted-foreground"
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

const KIND_LABELS: Record<AppKind, string> = {
  static: "Static site (HTML/CSS/JS)",
  pixi: "Python app (pixi)",
  image: "Container image",
};

/** Name, display name, namespace and what kind of app it is. */
export function BasicsSection({ form }: { form: FormContext }) {
  const { nameInput, displayName, description, thumbnail, namespace, kind, pixiTask } = form.state;
  const { set, dispatch, fieldProps, isEdit, namespaces } = form;
  // The form switches between an image and a source (upload, git, pvc) only
  // at launch; an edit keeps the kind of source the App has.
  const imageLocked = isEdit && form.initial?.source?.type === "image";
  const offerImage = imageLocked || (!isEdit && form.imageRegistries.length > 0);
  const kindItems: Partial<Record<AppKind, string>> = imageLocked
    ? { image: KIND_LABELS.image }
    : {
        static: KIND_LABELS.static,
        pixi: KIND_LABELS.pixi,
        ...(offerImage ? { image: KIND_LABELS.image } : {}),
      };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Basics</CardTitle>
      </CardHeader>
      {/* Pairs that belong together share a row (the two names, then where it
          runs and what it is); free text spans the card. */}
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          id="name"
          label="Name"
          adornment={isEdit ? <FixedAfterLaunch /> : null}
          help={
            isEdit
              ? null
              : "Lowercase letters, digits and hyphens. Also used as the default subdomain."
          }
          form={form}
        >
          <Input
            id="name"
            {...fieldProps("name", isEdit ? undefined : "name-help")}
            placeholder="sales-dashboard"
            value={nameInput}
            disabled={isEdit}
            onChange={(e) => dispatch({ type: "name", value: e.target.value })}
          />
        </FormField>
        <FormField id="displayName" label="Display name" form={form}>
          <Input
            id="displayName"
            {...fieldProps("displayName")}
            placeholder="Sales Dashboard"
            value={displayName}
            onChange={(e) => set("displayName", e.target.value)}
          />
        </FormField>
        <FormField id="description" label="Description" className="sm:col-span-2">
          <Input
            id="description"
            placeholder="Optional short description"
            value={description}
            onChange={(e) => set("description", e.target.value)}
          />
        </FormField>
        <FormField id="thumbnail" label="Thumbnail URL" className="sm:col-span-2">
          <Input
            id="thumbnail"
            placeholder="https://…/icon.png (optional)"
            value={thumbnail}
            onChange={(e) => set("thumbnail", e.target.value)}
          />
        </FormField>
        <FormField
          id="namespace"
          labelId="namespace-label"
          label="Namespace"
          adornment={isEdit ? <FixedAfterLaunch /> : null}
          form={form}
        >
          <Select
            value={namespace}
            onValueChange={(v) => set("namespace", v as string)}
            disabled={isEdit}
          >
            <SelectTrigger
              id="namespace"
              aria-labelledby="namespace-label"
              className={SELECT_TRIGGER}
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
        </FormField>
        <FormField
          labelId="kind-label"
          label="App type"
          adornment={imageLocked ? <FixedAfterLaunch /> : null}
        >
          <Select
            value={kind}
            onValueChange={(v) => set("kind", v as AppKind)}
            items={kindItems}
            disabled={imageLocked}
          >
            <SelectTrigger aria-labelledby="kind-label" className={SELECT_TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(kindItems).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {kind === "pixi" ? (
          <FormField
            id="pixiTask"
            label="Launch task"
            adornment={
              <InfoTip label="About Launch task">
                A task defined in your pixi.toml. The app starts with{" "}
                <span className="font-mono">pixi run {pixiTask || "<task>"}</span>.
              </InfoTip>
            }
            help="The pixi task that starts your server."
            form={form}
            className="sm:col-span-2"
          >
            <Input
              id="pixiTask"
              {...fieldProps("pixiTask", "pixiTask-help")}
              className="font-mono"
              placeholder="start"
              value={pixiTask}
              onChange={(e) => set("pixiTask", e.target.value)}
            />
          </FormField>
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
  if (kind === "image") return <ImageSourceCard form={form} />;
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
                    <p className={HELP}>
                      Needs a pixi.toml (or pyproject.toml) at the root · text files only · up to
                      ~900KB
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium text-sm">
                      Drop a .zip of your site, or a single .html file
                    </p>
                    <p className={HELP}>
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
            <FormField id="gitUrl" label="Repository URL" form={form} className="sm:col-span-3">
              <Input
                id="gitUrl"
                {...fieldProps("gitUrl")}
                placeholder="https://github.com/org/site"
                value={gitUrl}
                onChange={(e) => set("gitUrl", e.target.value)}
              />
            </FormField>
            <FormField id="gitRef" label="Branch / tag">
              <Input id="gitRef" value={gitRef} onChange={(e) => set("gitRef", e.target.value)} />
            </FormField>
            <FormField id="gitSubdir" label="Subdirectory" className="sm:col-span-2">
              <Input
                id="gitSubdir"
                placeholder="e.g. public (optional)"
                value={gitSubdir}
                onChange={(e) => set("gitSubdir", e.target.value)}
              />
            </FormField>
          </TabsPanel>

          <TabsPanel value="pvc" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FormField id="pvcClaim" label="Claim name" form={form} className="sm:col-span-2">
              <Input
                id="pvcClaim"
                {...fieldProps("pvcClaim")}
                placeholder="shared-sites"
                value={pvcClaim}
                onChange={(e) => set("pvcClaim", e.target.value)}
              />
            </FormField>
            <FormField id="pvcSubPath" label="Sub-path">
              <Input
                id="pvcSubPath"
                placeholder="site/ (optional)"
                value={pvcSubPath}
                onChange={(e) => set("pvcSubPath", e.target.value)}
              />
            </FormField>
          </TabsPanel>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** A prebuilt container image: reference, port, and optional command, args and user. */
function ImageSourceCard({ form }: { form: FormContext }) {
  const { imageRef, imagePort, imageCommand, imageArgs, imageRunAsUser } = form.state;
  const { set, fieldProps, imageRegistries } = form;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Image</CardTitle>
        <CardDescription>
          Run a published container image. It runs as a non-root user with no extra privileges; an
          image that needs root will not start.
        </CardDescription>
      </CardHeader>
      {/* The reference spans the card (it and the registry list run long); the
          two numbers pair up, then command and arguments with their shared help. */}
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          id="imageRef"
          label="Image"
          help={
            <>
              With a tag or a digest.{" "}
              {imageRegistries.length > 0 ? (
                <>
                  Allowed registries:{" "}
                  {/* break-words, not break-all: wrap between entries, and
                      inside one only when it is longer than the line. */}
                  <span className="break-words font-mono">{imageRegistries.join(", ")}</span>
                </>
              ) : null}
            </>
          }
          form={form}
          className="sm:col-span-2"
        >
          <Input
            id="imageRef"
            {...fieldProps("imageRef", "imageRef-help")}
            className="font-mono"
            placeholder="ghcr.io/org/app:1.2.3"
            value={imageRef}
            onChange={(e) => set("imageRef", e.target.value)}
          />
        </FormField>
        <FormField
          id="imagePort"
          label="Port"
          adornment={
            <InfoTip label="About Port">
              The port your server listens on, also passed as $PORT. 8080 and 8082 are taken by the
              app's sign-in sidecar.
            </InfoTip>
          }
          form={form}
        >
          <Input
            id="imagePort"
            {...fieldProps("imagePort")}
            inputMode="numeric"
            placeholder="8501"
            value={imagePort}
            onChange={(e) => set("imagePort", e.target.value)}
          />
        </FormField>
        <FormField
          id="imageRunAsUser"
          label="Run as user ID"
          help="For images whose user is a name, not a number."
          form={form}
        >
          <Input
            id="imageRunAsUser"
            {...fieldProps("imageRunAsUser", "imageRunAsUser-help")}
            inputMode="numeric"
            placeholder="Image default"
            value={imageRunAsUser}
            onChange={(e) => set("imageRunAsUser", e.target.value)}
          />
        </FormField>
        <FormField id="imageCommand" label="Command">
          <Textarea
            id="imageCommand"
            aria-describedby="imageArgs-help"
            className="font-mono placeholder:font-sans"
            rows={2}
            placeholder="Image default"
            value={imageCommand}
            onChange={(e) => set("imageCommand", e.target.value)}
          />
        </FormField>
        <FormField id="imageArgs" label="Arguments">
          <Textarea
            id="imageArgs"
            aria-describedby="imageArgs-help"
            className="font-mono placeholder:font-sans"
            rows={2}
            placeholder="Image default"
            value={imageArgs}
            onChange={(e) => set("imageArgs", e.target.value)}
          />
        </FormField>
        {/* The negative margin sets the shared help as close to both boxes as
            a field's own help (gap-1.5) sits to its control. */}
        <p id="imageArgs-help" className="-mt-2.5 text-muted-foreground text-sm sm:col-span-2">
          Command and arguments replace the image's entrypoint and arguments: one per line, no
          shell.
        </p>
      </CardContent>
    </Card>
  );
}

/** True when the App runs with anything but the defaults: one replica, no resources, cluster idling. */
function hasCustomRuntime(app?: App): boolean {
  const runtime = app?.runtime;
  const res = runtime?.resources;
  const amounts = { ...res?.requests, ...res?.limits };
  return (
    (runtime?.replicas ?? 1) !== 1 ||
    Object.keys(amounts).length > 0 ||
    Boolean(runtime?.keepAlive) ||
    runtime?.idleTimeoutMinutes != null
  );
}

/** keepAlive and the idle timeout: when an unvisited app scales to zero. */
function IdleFields({ form }: { form: FormContext }) {
  const { keepAlive, idleTimeout } = form.state;
  const { set, fieldProps, idleDefaultMinutes } = form;
  const clusterDefault =
    idleDefaultMinutes > 0
      ? `${idleDefaultMinutes} min (cluster default)`
      : "Off (cluster default)";
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p id="keepAlive-label" className="font-medium text-sm">
            Keep running when idle
          </p>
          <p id="keepAlive-help" className={HELP}>
            Never scale this app to zero. Use it for apps that must answer at once or work in the
            background.
          </p>
        </div>
        <Switch
          checked={keepAlive}
          onCheckedChange={(v) => set("keepAlive", v)}
          aria-labelledby="keepAlive-label"
          aria-describedby="keepAlive-help"
        />
      </div>
      <FormField
        id="idleTimeout"
        label="Idle timeout (minutes)"
        help={`After this long without a request the app scales to zero, and the next visit starts it again (a few seconds, longer for Python apps). ${IDLE_MIN} to ${IDLE_MAX}; leave empty for the cluster default.`}
        form={form}
      >
        <Input
          id="idleTimeout"
          inputMode="numeric"
          className="max-w-xs"
          placeholder={clusterDefault}
          disabled={keepAlive}
          {...fieldProps("idleTimeout", "idleTimeout-help")}
          value={idleTimeout}
          onChange={(e) => set("idleTimeout", e.target.value)}
        />
      </FormField>
    </div>
  );
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
          <p
            id="env-warning"
            className="flex items-start gap-1.5 text-muted-foreground-strong text-sm"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            Anyone who can see this app can read these values. Put API keys, tokens and passwords
            under Secrets instead.
          </p>
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
                aria-describedby="env-warning"
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
            {/* Same columns as the resources below, so Replicas lines up with them. */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <FormField id="replicas" label="Replicas">
                <Input
                  id="replicas"
                  type="number"
                  min={0}
                  max={10}
                  value={replicas}
                  onChange={(e) => set("replicas", Number(e.target.value))}
                />
              </FormField>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <FormField id="cpuReq" label="CPU request">
                <Input
                  id="cpuReq"
                  placeholder="250m"
                  value={cpuReq}
                  onChange={(e) => set("cpuReq", e.target.value)}
                />
              </FormField>
              <FormField id="memReq" label="Memory request">
                <Input
                  id="memReq"
                  placeholder="512Mi"
                  value={memReq}
                  onChange={(e) => set("memReq", e.target.value)}
                />
              </FormField>
              <FormField id="cpuLim" label="CPU limit">
                <Input
                  id="cpuLim"
                  placeholder="500m"
                  value={cpuLim}
                  onChange={(e) => set("cpuLim", e.target.value)}
                />
              </FormField>
              <FormField id="memLim" label="Memory limit">
                <Input
                  id="memLim"
                  placeholder="1Gi"
                  value={memLim}
                  onChange={(e) => set("memLim", e.target.value)}
                />
              </FormField>
            </div>
            <IdleFields form={form} />
            <p className={HELP}>
              Python apps must serve on <span className="font-mono">0.0.0.0:$PORT</span> (8080, or
              8081 when groups or users restrict the app or it can idle).
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
              <p id="public-help" className={HELP}>
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
              <FormField
                id="groups"
                label="Allowed groups"
                help="Only members of these Keycloak groups can open the app; everyone else gets 403. Leave groups and users empty to allow any signed-in user. Changes apply when a user's session token refreshes (a few minutes)."
              >
                <Input
                  id="groups"
                  placeholder="comma-separated"
                  aria-describedby="groups-help"
                  value={groups}
                  onChange={(e) => set("groups", e.target.value)}
                />
              </FormField>
              <FormField
                id="users"
                label="Allowed users"
                help="Keycloak usernames who can open the app even if they are not in an allowed group."
              >
                <Input
                  id="users"
                  placeholder="comma-separated usernames"
                  aria-describedby="users-help"
                  value={users}
                  onChange={(e) => set("users", e.target.value)}
                />
              </FormField>
            </div>
          ) : null}
          <FormField
            id="subdomain"
            label="Subdomain"
            help={isEdit ? "Subdomain is fixed after launch." : null}
            form={form}
            className={row}
          >
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
              <span className="inline-flex max-w-[60%] shrink-0 items-center truncate rounded-r-md border border-input border-l-0 bg-muted px-3 font-mono text-muted-foreground-strong text-sm">
                .{appsDomain}
              </span>
            </div>
          </FormField>
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
                <p id="landing-help" className={HELP}>
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

/**
 * Write-only secret values. Saved keys show their name only: the API never
 * returns a value, so an empty field keeps it and typing replaces it.
 */
export function SecretsSection({ form }: { form: FormContext }) {
  const { secrets, removedSecrets } = form.state;
  const { set, isEdit } = form;
  const props = form.fieldProps("secrets", "secrets-help");
  const update = (i: number, change: Partial<(typeof secrets)[number]>) =>
    set(
      "secrets",
      secrets.map((row, j) => (j === i ? { ...row, ...change } : row)),
    );
  const remove = (i: number) => {
    const row = secrets[i];
    set(
      "secrets",
      secrets.filter((_, j) => j !== i),
    );
    if (row.stored) set("removedSecrets", [...removedSecrets, row.name]);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>
          Credentials such as API keys, tokens and database URLs, passed to the app as environment
          variables. They are kept in a Kubernetes Secret only this app reads and are never shown
          again, here or anywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <fieldset className="flex flex-col items-start gap-2">
          <legend className="sr-only">Secrets</legend>
          {secrets.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
            <div key={i} className="flex w-full items-center gap-2">
              <Input
                id={i === 0 && !row.stored ? CONTROL_IDS.secrets : undefined}
                aria-label={`Secret ${i + 1} name`}
                placeholder="NAME"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                value={row.name}
                // A saved key keeps its name: remove it and add a new one to rename.
                readOnly={row.stored}
                {...props}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <Input
                id={i === 0 && row.stored ? CONTROL_IDS.secrets : undefined}
                type="password"
                aria-label={`Value of secret ${row.name || i + 1}`}
                placeholder={row.stored ? "Saved: type to replace" : "value"}
                className="font-mono"
                autoComplete="new-password"
                spellCheck={false}
                value={row.value}
                {...props}
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove secret ${row.name || i + 1}`}
                onClick={() => remove(i)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => set("secrets", [...secrets, { name: "", value: "", stored: false }])}
          >
            <Plus /> Add secret
          </Button>
          <FieldError form={form} field="secrets" />
          <p id="secrets-help" className={HELP}>
            Names are environment variable names, such as OPENAI_API_KEY.
            {isEdit
              ? " Leave a saved value empty to keep it. Saving a new value restarts the app."
              : ""}
          </p>
        </fieldset>
      </CardContent>
    </Card>
  );
}

/** Who besides the owner may manage the app; only the owner or an admin may change it. */
export function ManagersSection({ form }: { form: FormContext }) {
  const { managerUsers, managerGroups } = form.state;
  const { set, isEdit, initial } = form;
  const editable = canEditManagers(isEdit, initial);
  const describedBy = editable ? "managers-help" : "managers-help managers-locked";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Managers</CardTitle>
        <CardDescription>
          Managers can edit, start, stop, restart and delete this app, replace its secrets and read
          its logs, like its owner, but cannot change this list. Admins can always manage it. This
          does not change who can open the app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField id="managerUsers" label="Manager users">
          <Input
            id="managerUsers"
            placeholder="comma-separated usernames"
            aria-describedby={describedBy}
            value={managerUsers}
            disabled={!editable}
            onChange={(e) => set("managerUsers", e.target.value)}
          />
        </FormField>
        <FormField id="managerGroups" label="Manager groups">
          <Input
            id="managerGroups"
            placeholder="comma-separated"
            aria-describedby={describedBy}
            value={managerGroups}
            disabled={!editable}
            onChange={(e) => set("managerGroups", e.target.value)}
          />
        </FormField>
        <p id="managers-help" className={HELP}>
          Keycloak usernames and groups. Group membership is read from each person's sign-in token,
          so a change to their groups applies when it refreshes.
        </p>
        {editable ? null : (
          <p
            id="managers-locked"
            className="flex items-center gap-1.5 text-muted-foreground text-sm"
          >
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            Only the owner or an admin can change who manages this app.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
