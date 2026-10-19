import type { App, AppCreate, AppPatch, AppSource, EnvVar, ResourceAmounts } from "@/lib/types";

export const SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Source authoring tabs. "keep" is edit-only: leave the current source as-is. */
export type SourceTab = "upload" | "git" | "pvc" | "keep";

/** What the app is: a static site served by nginx, or a Python/pixi service. */
export type AppKind = "static" | "pixi";

/** Resource presets that fill both requests and limits in one click. */
export const PRESETS = {
  Small: { cpuReq: "100m", memReq: "128Mi", cpuLim: "250m", memLim: "256Mi" },
  Medium: { cpuReq: "250m", memReq: "512Mi", cpuLim: "500m", memLim: "1Gi" },
  Large: { cpuReq: "500m", memReq: "1Gi", cpuLim: "1", memLim: "2Gi" },
} as const;
export type Preset = keyof typeof PRESETS;

export type SubmitPayload =
  | { kind: "create"; body: AppCreate }
  | { kind: "upload"; manifest: Omit<AppCreate, "source">; file: File }
  | { kind: "patch"; body: AppPatch };

export interface FormState {
  nameInput: string;
  displayName: string;
  description: string;
  thumbnail: string;
  namespace: string;
  kind: AppKind;
  pixiTask: string;
  sourceTab: SourceTab;
  file: File | null;
  gitUrl: string;
  gitRef: string;
  gitSubdir: string;
  pvcClaim: string;
  pvcSubPath: string;
  envVars: EnvVar[];
  replicas: number;
  cpuReq: string;
  memReq: string;
  cpuLim: string;
  memLim: string;
  isPublic: boolean;
  groups: string;
  subdomain: string;
  onLandingPage: boolean;
}

export type FormAction =
  | { [K in keyof FormState]: { type: "set"; field: K; value: FormState[K] } }[keyof FormState]
  // The subdomain follows the name until the user edits it.
  | { type: "name"; value: string }
  | { type: "preset"; preset: Preset };

export function initialState(initial: App | undefined, isEdit: boolean): FormState {
  const res = initial?.runtime?.resources;
  return {
    nameInput: initial?.name ?? "",
    displayName: initial?.displayName ?? "",
    description: initial?.description ?? "",
    thumbnail: initial?.thumbnail ?? "",
    namespace: initial?.namespace ?? "",
    // Presence of a pixi task is the wire discriminator.
    kind: initial?.runtime?.pixiTask ? "pixi" : "static",
    pixiTask: initial?.runtime?.pixiTask ?? "",
    sourceTab: isEdit ? "keep" : "upload",
    file: null,
    gitUrl: initial?.source?.git?.url ?? "",
    gitRef: initial?.source?.git?.ref ?? "main",
    gitSubdir: initial?.source?.git?.subdir ?? "",
    pvcClaim: initial?.source?.pvc?.claimName ?? "",
    pvcSubPath: initial?.source?.pvc?.subPath ?? "",
    envVars: initial?.runtime?.env ?? [],
    replicas: initial?.runtime?.replicas ?? 1,
    cpuReq: res?.requests?.cpu ?? "",
    memReq: res?.requests?.memory ?? "",
    cpuLim: res?.limits?.cpu ?? "",
    memLim: res?.limits?.memory ?? "",
    isPublic: initial?.access?.public ?? false,
    groups: (initial?.access?.groups ?? []).join(", "),
    subdomain: initial?.access?.subdomain ?? "",
    // Landing-page tile is opt-in: unset on the App means "cluster default"
    // (off unless the chart enables it), so a new app only sends the field
    // when the switch is on; edits always send it so an opt-out is explicit.
    onLandingPage: initial?.landingPage?.enabled ?? false,
  };
}

export function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "set":
      return { ...state, [action.field]: action.value };
    case "name": {
      const follows = !state.subdomain || state.subdomain === state.nameInput;
      return {
        ...state,
        nameInput: action.value,
        subdomain: follows ? action.value : state.subdomain,
      };
    }
    case "preset":
      return { ...state, ...PRESETS[action.preset] };
  }
}

/** The first problem with the form, and the control it belongs to. */
export function validate(s: FormState, isEdit: boolean): { field: string; message: string } | null {
  if (!isEdit) {
    if (!s.nameInput) return { field: "name", message: "Give the app a name." };
    if (!SUBDOMAIN_RE.test(s.nameInput))
      return { field: "name", message: "Name must be lowercase letters, digits, and hyphens." };
    if (!s.subdomain) return { field: "subdomain", message: "Pick a subdomain." };
    if (!SUBDOMAIN_RE.test(s.subdomain))
      return {
        field: "subdomain",
        message: "Subdomain must be lowercase letters, digits, and hyphens.",
      };
  }
  if (!s.displayName) return { field: "displayName", message: "Give the app a display name." };
  if (!s.namespace) return { field: "namespace", message: "Pick a namespace." };
  if (s.kind === "pixi" && !s.pixiTask)
    return { field: "pixiTask", message: "Enter the pixi task that launches the app." };
  if (s.sourceTab === "upload" && !s.file) {
    return {
      field: "file",
      message:
        s.kind === "pixi"
          ? "Choose a .zip of your pixi project to upload."
          : "Choose a .zip or .html file to upload.",
    };
  }
  if (
    s.kind === "pixi" &&
    s.sourceTab === "upload" &&
    s.file &&
    !s.file.name.toLowerCase().endsWith(".zip")
  ) {
    return { field: "file", message: "Pixi apps must be uploaded as a .zip archive." };
  }
  if (s.sourceTab === "git" && !s.gitUrl)
    return { field: "gitUrl", message: "Enter the git repository URL." };
  if (s.sourceTab === "pvc" && !s.pvcClaim)
    return { field: "pvcClaim", message: "Enter the PVC claim name." };
  return null;
}

// The form edits cpu and memory; any other resource the App already has
// (ephemeral-storage, a GPU limit set with kubectl) is carried over. null
// clears resources on an edit, since an omitted field keeps its value.
function buildResources(s: FormState, initial: App | undefined) {
  const merge = (base: ResourceAmounts | undefined, cpu: string, memory: string) => {
    const { cpu: _cpu, memory: _memory, ...rest } = base ?? {};
    const out: ResourceAmounts = { ...rest };
    if (cpu) out.cpu = cpu;
    if (memory) out.memory = memory;
    return Object.keys(out).length ? out : undefined;
  };
  const current = initial?.runtime?.resources ?? undefined;
  const requests = merge(current?.requests, s.cpuReq, s.memReq);
  const limits = merge(current?.limits, s.cpuLim, s.memLim);
  return requests || limits ? { ...current, requests, limits } : null;
}

function buildSource(s: FormState): AppSource | undefined {
  if (s.sourceTab === "git")
    return {
      type: "git",
      git: { url: s.gitUrl, ref: s.gitRef || "main", subdir: s.gitSubdir || undefined },
    };
  if (s.sourceTab === "pvc")
    return { type: "pvc", pvc: { claimName: s.pvcClaim, subPath: s.pvcSubPath || undefined } };
  return undefined; // 'upload' handled separately; 'keep' leaves source untouched
}

export function splitGroups(raw: string): string[] {
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

/** What the form submits, or null if the upload tab has no file yet. */
export function buildPayload(
  s: FormState,
  isEdit: boolean,
  initial: App | undefined,
): SubmitPayload | null {
  const runtime = {
    replicas: s.replicas,
    env: s.envVars.filter((e) => e.name),
    resources: buildResources(s, initial),
    pixiTask: s.kind === "pixi" ? s.pixiTask : "",
  };

  if (isEdit) {
    const body: AppPatch = {
      displayName: s.displayName,
      description: s.description,
      thumbnail: s.thumbnail,
      runtime,
      access: {
        public: s.isPublic,
        groups: splitGroups(s.groups),
        subdomain: initial?.access?.subdomain ?? s.subdomain,
      },
      landingPage: { enabled: s.onLandingPage },
    };
    const source = buildSource(s);
    if (source) body.source = source;
    return { kind: "patch", body };
  }

  const base = {
    name: s.nameInput,
    namespace: s.namespace,
    displayName: s.displayName,
    description: s.description || undefined,
    thumbnail: s.thumbnail || undefined,
    runtime,
    access: { public: s.isPublic, groups: splitGroups(s.groups), subdomain: s.subdomain },
    ...(s.onLandingPage ? { landingPage: { enabled: true } } : {}),
  };

  if (s.sourceTab === "upload")
    return s.file ? { kind: "upload", manifest: base, file: s.file } : null;
  return { kind: "create", body: { ...base, source: buildSource(s) } as AppCreate };
}

/** "secret site/token", "configMap cfg/key" or the reference's kind. */
export function describeValueFrom(ref: Record<string, unknown>): string {
  const [kind, target] = Object.entries(ref)[0] ?? ["reference", {}];
  const { name, key } = (target ?? {}) as { name?: string; key?: string };
  const label = kind.replace(/KeyRef$|Ref$/, "");
  return name ? `from ${label} ${name}${key ? `/${key}` : ""}` : `from ${label}`;
}
