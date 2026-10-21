/*
 * The App's own types come from its CRD: crd.gen.ts is generated from
 * charts/nebari-apps/crds/apps.nebari.dev_apps.yaml by
 * .github/scripts/gen_crd_types.py, and CI fails when it is stale. This file
 * adds the API's wire shapes on top (the flattened App it returns, the create
 * and patch bodies) and says where the wire differs from the CRD.
 */
import type * as Crd from "./crd.gen";

export type SourceType = Crd.AppSource["type"];
export type GitSource = Crd.GitSource;
export type AppSource = Crd.AppSource;
export type EnvVar = Crd.EnvVar;
/** Who may manage the App besides its owner (not who may open it). */
export type AppManagers = NonNullable<Crd.AppAccess["managers"]>;
export type AppAccess = Omit<Crd.AppAccess, "managers"> & {
  /** null in a PATCH clears the list; an omitted field keeps the stored value. */
  managers?: AppManagers | null;
};
/** The caller's relationship to an App, computed per request by the API; "" = none. */
export type AppRole = "owner" | "manager" | "admin" | "";
/** Landing-page tile. `enabled` unset = follow the cluster default. */
export type AppLandingPage = Crd.AppLandingPage;
export type AppCondition = Crd.AppCondition;

/** Resource name (cpu, memory, ephemeral-storage, nvidia.com/gpu, ...) -> quantity, as the API returns it. */
export type ResourceAmounts = Record<string, string | undefined>;

export type AppRuntime = Omit<Crd.AppRuntime, "resources" | "idleTimeoutMinutes"> & {
  /** Requests and limits only. null in a PATCH clears them; an omitted field keeps the stored value. */
  resources?: { requests?: ResourceAmounts; limits?: ResourceAmounts } | null;
  /** Minutes without a request before the app scales to zero. null in a PATCH returns to the cluster default. */
  idleTimeoutMinutes?: number | null;
};

/** The API always returns these status fields; the CRD leaves them optional. */
export type AppStatus = Required<Pick<Crd.AppStatus, "conditions" | "message" | "url">> & {
  /** Empty until the operator first reconciles the App. */
  phase: NonNullable<Crd.AppStatus["phase"]> | "";
  replicas?: Crd.AppReplicas | null;
  /** When the app last served a request; empty unless it can idle. */
  lastActivityTime?: string;
  /** The metadata.generation the operator last reconciled (0 before its first; older APIs omit it). */
  observedGeneration?: number;
};

export interface App {
  name: string;
  namespace: string;
  displayName: string;
  description: string;
  thumbnail: string;
  owner: string;
  createdAt: string;
  source?: AppSource;
  runtime?: AppRuntime;
  access?: AppAccess;
  landingPage?: AppLandingPage | null;
  status: AppStatus;
  /** metadata.generation, bumped on every spec change; older APIs leave it out. */
  generation?: number;
  /** Older APIs leave it out. */
  role?: AppRole;
}

export interface AppCreate {
  name: string;
  namespace: string;
  displayName: string;
  description?: string;
  source: AppSource;
  runtime?: AppRuntime;
  access: AppAccess;
  landingPage?: AppLandingPage;
  /** Write-only secret values, NAME -> value; the API returns only the names (runtime.secretKeys). */
  secrets?: Record<string, string>;
}

export interface AppPatch {
  displayName?: string;
  description?: string;
  thumbnail?: string;
  source?: AppSource;
  runtime?: AppRuntime;
  access?: AppAccess;
  landingPage?: AppLandingPage;
  /** Set or rotate (a value) or remove (null) secret keys; names not sent are kept. */
  secrets?: Record<string, string | null>;
}

/** The `app` container's CPU ("500m") and memory ("512Mi"); "" when unset. */
export interface PodResources {
  cpu: string;
  memory: string;
}

/** How the `app` container's previous run ended (e.g. reason "OOMKilled"). */
export interface PodTermination {
  reason: string;
  exitCode: number;
  finishedAt: string;
}

export interface PodMetric {
  name: string;
  /** Usage from metrics.k8s.io ("12m", "34Mi"); "" without a metrics server. */
  cpu: string;
  memory: string;
  /** From the pod, so present with or without a metrics server (older APIs omit them). */
  restarts?: number;
  lastTermination?: PodTermination | null;
  /** When the `app` container started running; null while it is not. */
  startedAt?: string | null;
  limits?: PodResources;
  requests?: PodResources;
}

export interface AppMetrics {
  /** Whether metrics.k8s.io answered (usage present); pod health comes either way. */
  available: boolean;
  pods: PodMetric[];
}

export interface Capabilities {
  appsDomain: string;
  sourceTypes: SourceType[];
  namespaces: string[];
  /** Cluster default idle timeout in minutes; 0 = apps stay up unless they set one. */
  idleTimeoutMinutes?: number;
  /** Registries image apps may pull from; empty (or absent, older APIs) = image apps are off. */
  imageRegistries?: string[];
}

export interface AppUsage {
  namespace: string;
  name: string;
  cpu: number; // millicores
  memory: number; // Mi
  restarts: number;
}

export interface NamespaceUsage {
  namespace: string;
  cpu: number;
  memory: number;
}

export interface ClusterMetrics {
  usageAvailable: boolean;
  apps: AppUsage[];
  byNamespace: NamespaceUsage[];
}

export interface UiConfig {
  authEnabled: boolean;
  keycloak: { url: string; realm: string; clientId: string };
  appsDomain: string;
  appsScheme?: string;
  /** Release (e.g. 0.2.0) and image build (e.g. sha-abc1234) of the API. */
  version?: string;
  build?: string;
}

/** GET /api/v1/version: the API's release and image build. */
export interface ApiVersion {
  version: string;
  build: string;
}

/** GET /api/v1/auth/me: who the API sees, and whether it treats them as an admin. */
export interface Me {
  username: string;
  email: string;
  groups: string[];
  admin: boolean;
}

export interface AppEvent {
  type: string;
  reason: string;
  message: string;
  kind: string;
  object: string;
  count: number;
  lastTimestamp: string;
}
