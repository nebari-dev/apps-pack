import { groupPath } from "@/lib/access";
import type { App, AppCreate, AppPatch, AppSource, EnvVar, ResourceAmounts } from "@/lib/types";

export const SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Source authoring tabs. "keep" is edit-only: leave the current source as-is. */
export type SourceTab = "upload" | "git" | "pvc" | "keep";

/** What the app is: a static site served by nginx, a Python/pixi service, or a prebuilt container image. */
export type AppKind = "static" | "pixi" | "image";

/** The ports the auth sidecar takes in an image App's pod (the CRD's rule). */
export const IMAGE_RESERVED_PORTS = [8080, 8082];
export const IMAGE_PORT_MIN = 1024;
export const IMAGE_PORT_MAX = 65535;

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

/** One row of the Secrets editor. */
export interface SecretRow {
  name: string;
  /** What the user typed; empty on a saved key means "keep the stored value". */
  value: string;
  /** Already stored on the App (an edit): its name is fixed and its value is never shown. */
  stored: boolean;
}

/** A secret name becomes an environment variable name (the CRD's runtime.secretKeys rule). */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  /** source.image fields as typed (kind "image"). */
  imageRef: string;
  imagePort: string;
  /** One command / argument per line. */
  imageCommand: string;
  imageArgs: string;
  imageRunAsUser: string;
  envVars: EnvVar[];
  /** Secret keys: saved ones (names only) and new ones with their values. */
  secrets: SecretRow[];
  /** Saved secret keys the user removed; an edit sends them as null. */
  removedSecrets: string[];
  replicas: number;
  /** runtime.keepAlive: never scale to zero when idle. */
  keepAlive: boolean;
  /** runtime.idleTimeoutMinutes as typed; empty = the cluster default. */
  idleTimeout: string;
  cpuReq: string;
  memReq: string;
  cpuLim: string;
  memLim: string;
  isPublic: boolean;
  groups: string;
  /** access.managers.users, comma-separated. */
  managerUsers: string;
  /** access.managers.groups, comma-separated. */
  managerGroups: string;
  subdomain: string;
  onLandingPage: boolean;
  /** Fields the user has left (blurred); their problems are shown. */
  touched: Partial<Record<Field, true>>;
  /** Set by a submit attempt: every problem is shown from then on. */
  submitted: boolean;
}

/** The controls validate() can report a problem for, in form order. */
export type Field =
  | "name"
  | "displayName"
  | "namespace"
  | "pixiTask"
  | "file"
  | "gitUrl"
  | "pvcClaim"
  | "imageRef"
  | "imagePort"
  | "imageRunAsUser"
  | "idleTimeout"
  | "secrets"
  | "groups"
  | "subdomain";

export interface Problem {
  field: Field;
  message: string;
}

export type FormAction =
  | { [K in keyof FormState]: { type: "set"; field: K; value: FormState[K] } }[keyof FormState]
  // The subdomain follows the name until the user edits it.
  | { type: "name"; value: string }
  | { type: "preset"; preset: Preset }
  | { type: "touch"; field: Field }
  | { type: "submit" };

/**
 * "Sales Dashboard!" -> "sales-dashboard": lowercase, anything outside
 * [a-z0-9-] becomes a hyphen, runs of hyphens collapse, and leading and
 * trailing hyphens go, so the mirrored subdomain is always a usable label.
 */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function initialState(initial: App | undefined, isEdit: boolean): FormState {
  const res = initial?.runtime?.resources;
  return {
    nameInput: initial?.name ?? "",
    displayName: initial?.displayName ?? "",
    description: initial?.description ?? "",
    thumbnail: initial?.thumbnail ?? "",
    namespace: initial?.namespace ?? "",
    // An image source, else the presence of a pixi task, is the wire discriminator.
    kind:
      initial?.source?.type === "image" ? "image" : initial?.runtime?.pixiTask ? "pixi" : "static",
    pixiTask: initial?.runtime?.pixiTask ?? "",
    sourceTab: isEdit ? "keep" : "upload",
    file: null,
    gitUrl: initial?.source?.git?.url ?? "",
    gitRef: initial?.source?.git?.ref ?? "main",
    gitSubdir: initial?.source?.git?.subdir ?? "",
    pvcClaim: initial?.source?.pvc?.claimName ?? "",
    pvcSubPath: initial?.source?.pvc?.subPath ?? "",
    imageRef: initial?.source?.image?.reference ?? "",
    imagePort: initial?.source?.image?.port != null ? String(initial.source.image.port) : "",
    imageCommand: (initial?.source?.image?.command ?? []).join("\n"),
    imageArgs: (initial?.source?.image?.args ?? []).join("\n"),
    imageRunAsUser:
      initial?.source?.image?.runAsUser != null ? String(initial.source.image.runAsUser) : "",
    envVars: initial?.runtime?.env ?? [],
    secrets: (initial?.runtime?.secretKeys ?? []).map((name) => ({
      name,
      value: "",
      stored: true,
    })),
    removedSecrets: [],
    replicas: initial?.runtime?.replicas ?? 1,
    keepAlive: initial?.runtime?.keepAlive ?? false,
    idleTimeout:
      initial?.runtime?.idleTimeoutMinutes != null
        ? String(initial.runtime.idleTimeoutMinutes)
        : "",
    cpuReq: res?.requests?.cpu ?? "",
    memReq: res?.requests?.memory ?? "",
    cpuLim: res?.limits?.cpu ?? "",
    memLim: res?.limits?.memory ?? "",
    isPublic: initial?.access?.public ?? false,
    groups: (initial?.access?.groups ?? []).join(", "),
    managerUsers: (initial?.access?.managers?.users ?? []).join(", "),
    managerGroups: (initial?.access?.managers?.groups ?? []).join(", "),
    subdomain: initial?.access?.subdomain ?? "",
    // Unset shows as off; the tile is opt-in unless the cluster default says
    // otherwise (see buildPayload).
    onLandingPage: initial?.landingPage?.enabled ?? false,
    touched: {},
    submitted: false,
  };
}

export function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "set":
      return { ...state, [action.field]: action.value };
    case "name": {
      // The subdomain mirrors the slugified name until the user edits it.
      const follows = !state.subdomain || state.subdomain === slugify(state.nameInput);
      return {
        ...state,
        nameInput: action.value,
        subdomain: follows ? slugify(action.value) : state.subdomain,
      };
    }
    case "preset":
      return { ...state, ...PRESETS[action.preset] };
    case "touch":
      return state.touched[action.field]
        ? state
        : { ...state, touched: { ...state.touched, [action.field]: true } };
    case "submit":
      return { ...state, submitted: true };
  }
}

/**
 * Every problem with the form, at most one per control, in form order. The
 * form shows a problem once its control is touched or after a submit attempt.
 */
export function validate(s: FormState, isEdit: boolean): Problem[] {
  const problems: Problem[] = [];
  const add = (field: Field, message: string) => problems.push({ field, message });
  if (!isEdit) {
    if (!s.nameInput) add("name", "Give the app a name.");
    else if (!SUBDOMAIN_RE.test(s.nameInput))
      add("name", "Name must be lowercase letters, digits, and hyphens.");
  }
  if (!s.displayName) add("displayName", "Give the app a display name.");
  if (!s.namespace) add("namespace", "Pick a namespace.");
  if (s.kind === "pixi" && !s.pixiTask)
    add("pixiTask", "Enter the pixi task that launches the app.");
  if (s.kind === "image") {
    if (!s.imageRef.trim()) add("imageRef", "Enter the image to run.");
    else if (!IMAGE_REF_RE.test(s.imageRef.trim()))
      add("imageRef", "Give the image a tag (:1.2.3) or a digest (@sha256:…).");
    const port = parsePort(s.imagePort);
    if (port === null)
      add(
        "imagePort",
        `Port must be a whole number from ${IMAGE_PORT_MIN} to ${IMAGE_PORT_MAX}, not ${IMAGE_RESERVED_PORTS.join(" or ")}.`,
      );
    if (s.imageRunAsUser.trim() && parseUid(s.imageRunAsUser) === null)
      add("imageRunAsUser", "User ID must be a whole number above 0, or empty.");
  } else if (s.sourceTab === "upload") {
    if (!s.file)
      add(
        "file",
        s.kind === "pixi"
          ? "Choose a .zip of your pixi project to upload."
          : "Choose a .zip or .html file to upload.",
      );
    else if (s.kind === "pixi" && !s.file.name.toLowerCase().endsWith(".zip"))
      add("file", "Pixi apps must be uploaded as a .zip archive.");
  }
  if (s.kind !== "image") {
    if (s.sourceTab === "git" && !s.gitUrl) add("gitUrl", "Enter the git repository URL.");
    if (s.sourceTab === "pvc" && !s.pvcClaim) add("pvcClaim", "Enter the PVC claim name.");
  }
  if (!s.keepAlive && s.idleTimeout.trim() && parseIdleTimeout(s.idleTimeout) === null)
    add(
      "idleTimeout",
      `Idle timeout must be a whole number of minutes from ${IDLE_MIN} to ${IDLE_MAX}, or empty.`,
    );
  const secretProblem = validateSecrets(s);
  if (secretProblem) add("secrets", secretProblem);
  if (!s.isPublic && splitList(s.groups).some((g) => !groupPath(g)))
    add("groups", "Each group must name a Keycloak group, such as finance or /parent/child.");
  if (!isEdit) {
    if (!s.subdomain) add("subdomain", "Pick a subdomain.");
    else if (!SUBDOMAIN_RE.test(s.subdomain))
      add("subdomain", "Subdomain must be lowercase letters, digits, and hyphens.");
  }
  return problems;
}

/** The first problem with the Secrets rows, if any. */
function validateSecrets(s: FormState): string | undefined {
  const envNames = new Set(s.envVars.map((e) => e.name).filter(Boolean));
  const seen = new Set<string>();
  for (const row of s.secrets) {
    if (!row.name && !row.value) continue; // an untouched new row is ignored
    if (!row.name) return "Give every secret a name.";
    if (!SECRET_NAME_RE.test(row.name))
      return `Secret name ${row.name} must be letters, digits and underscores, not starting with a digit.`;
    if (seen.has(row.name)) return `Secret ${row.name} is listed twice.`;
    seen.add(row.name);
    if (envNames.has(row.name))
      return `${row.name} is both a secret and an environment variable; keep one.`;
    if (!row.stored && !row.value) return `Enter a value for secret ${row.name}.`;
  }
  return undefined;
}

/**
 * The secret values a submit sends: new keys and saved keys given a new value,
 * plus (on an edit) removed saved keys as null. Undefined when there is nothing.
 */
export function buildSecrets(
  s: FormState,
  isEdit: boolean,
): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const row of s.secrets) if (row.name && row.value) out[row.name] = row.value;
  if (isEdit) for (const name of s.removedSecrets) if (!(name in out)) out[name] = null;
  return Object.keys(out).length ? out : undefined;
}

/**
 * A tag after the last "/" or a digest: the API and operator check the full
 * grammar and the registry allowlist; this only catches a missing tag early.
 */
const IMAGE_REF_RE = /^\S+(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/;

/** "8501" -> 8501; null outside the image port bounds or on a sidecar port. */
export function parsePort(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= IMAGE_PORT_MIN && n <= IMAGE_PORT_MAX && !IMAGE_RESERVED_PORTS.includes(n) ? n : null;
}

function parseUid(raw: string): number | null {
  const t = raw.trim();
  return /^\d+$/.test(t) && Number(t) > 0 ? Number(t) : null;
}

/** One entry per non-empty line (image command and args). */
function lines(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** runtime.idleTimeoutMinutes bounds (the CRD's). */
export const IDLE_MIN = 5;
export const IDLE_MAX = 43200;

/** "30" -> 30; null for anything that is not a whole number within the CRD's bounds. */
export function parseIdleTimeout(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= IDLE_MIN && n <= IDLE_MAX ? n : null;
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
  if (s.kind === "image") {
    const uid = parseUid(s.imageRunAsUser);
    const command = lines(s.imageCommand);
    const args = lines(s.imageArgs);
    return {
      type: "image",
      image: {
        reference: s.imageRef.trim(),
        port: parsePort(s.imagePort) ?? 0,
        ...(command.length ? { command } : {}),
        ...(args.length ? { args } : {}),
        ...(uid !== null ? { runAsUser: uid } : {}),
      },
    };
  }
  if (s.sourceTab === "git")
    return {
      type: "git",
      git: { url: s.gitUrl, ref: s.gitRef || "main", subdir: s.gitSubdir || undefined },
    };
  if (s.sourceTab === "pvc")
    return { type: "pvc", pvc: { claimName: s.pvcClaim, subPath: s.pvcSubPath || undefined } };
  return undefined; // 'upload' handled separately; 'keep' leaves source untouched
}

/**
 * Whether the caller may change who manages the App: anyone launching one,
 * and on an edit its owner or an admin (managers may not).
 */
export function canEditManagers(isEdit: boolean, initial: App | undefined): boolean {
  return !isEdit || initial?.role !== "manager";
}

function buildManagers(s: FormState) {
  const users = splitList(s.managerUsers);
  const groups = splitList(s.managerGroups);
  return users.length || groups.length ? { users, groups } : undefined;
}

/** "a, b ,c," -> ["a", "b", "c"]: the comma-separated list fields. */
export function splitList(raw: string): string[] {
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
  // An idle timeout typed while keepAlive is on is kept but has no effect.
  const idleTimeoutMinutes = parseIdleTimeout(s.idleTimeout);
  const runtime = {
    replicas: s.replicas,
    env: s.envVars.filter((e) => e.name),
    resources: buildResources(s, initial),
    pixiTask: s.kind === "pixi" ? s.pixiTask : "",
    // An edit sends both so turning them off reaches the App (null returns
    // the timeout to the cluster default); a launch sends only what is set.
    ...(isEdit
      ? { keepAlive: s.keepAlive, idleTimeoutMinutes }
      : {
          ...(s.keepAlive ? { keepAlive: true } : {}),
          ...(idleTimeoutMinutes !== null ? { idleTimeoutMinutes } : {}),
        }),
  };

  if (isEdit) {
    const body: AppPatch = {
      displayName: s.displayName,
      description: s.description,
      thumbnail: s.thumbnail,
      runtime,
      access: {
        public: s.isPublic,
        groups: splitList(s.groups),
        subdomain: initial?.access?.subdomain ?? s.subdomain,
      },
    };
    // A manager cannot change the list, so their edit leaves it out (the API
    // keeps the stored value); for the owner or an admin, null clears it.
    const managers = buildManagers(s);
    if (body.access && canEditManagers(isEdit, initial) && (managers || initial?.access?.managers))
      body.access.managers = managers ?? null;
    // An omitted landingPage keeps the stored value, so an App that relies on
    // the cluster default keeps doing so until the switch is flipped.
    if (s.onLandingPage !== (initial?.landingPage?.enabled ?? false))
      body.landingPage = { enabled: s.onLandingPage };
    const source = buildSource(s);
    if (source) body.source = source;
    const secrets = buildSecrets(s, true);
    if (secrets) body.secrets = secrets;
    return { kind: "patch", body };
  }

  const base = {
    name: s.nameInput,
    namespace: s.namespace,
    displayName: s.displayName,
    description: s.description || undefined,
    thumbnail: s.thumbnail || undefined,
    runtime,
    access: {
      public: s.isPublic,
      groups: splitList(s.groups),
      subdomain: s.subdomain,
      ...(buildManagers(s) ? { managers: buildManagers(s) } : {}),
    },
    // Sent either way, so the App gets what the switch shows even when the
    // cluster default is "on".
    landingPage: { enabled: s.onLandingPage },
    // A launch never sends null (buildSecrets only adds those on an edit).
    ...(buildSecrets(s, false)
      ? { secrets: buildSecrets(s, false) as Record<string, string> }
      : {}),
  };

  if (s.sourceTab === "upload" && s.kind !== "image")
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
