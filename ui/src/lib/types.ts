export type SourceType = "git" | "inline" | "pvc";

export interface GitSource {
  url: string;
  ref?: string;
  subdir?: string;
}

export interface AppSource {
  type: SourceType;
  git?: GitSource;
  inline?: { files: Record<string, string> };
  pvc?: { claimName: string; subPath?: string };
}

export interface EnvVar {
  name: string;
  value?: string;
  /** A Secret, ConfigMap or field reference set with kubectl; kept as is. */
  valueFrom?: Record<string, unknown>;
}

/** Resource name (cpu, memory, ephemeral-storage, nvidia.com/gpu, ...) -> quantity. */
export type ResourceAmounts = Record<string, string | undefined>;

export interface AppRuntime {
  env?: EnvVar[];
  replicas?: number;
  /** null in a PATCH clears it; an omitted field keeps the stored value. */
  resources?: { requests?: ResourceAmounts; limits?: ResourceAmounts } | null;
  /** Reserved (scale-to-zero); only round-tripped. */
  keepAlive?: boolean;
  /** When set, the app runs as a Python/pixi service via `pixi run <task>`. */
  pixiTask?: string;
}

export interface AppAccess {
  public: boolean;
  groups?: string[];
  users?: string[];
  subdomain: string;
}

/** Landing-page tile. `enabled` unset = follow the cluster default. */
export interface AppLandingPage {
  enabled?: boolean;
}

export interface AppCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface AppStatus {
  phase: string;
  url: string;
  replicas?: { desired: number; ready: number } | null;
  conditions: AppCondition[];
  message: string;
}

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
}

export interface AppPatch {
  displayName?: string;
  description?: string;
  thumbnail?: string;
  source?: AppSource;
  runtime?: AppRuntime;
  access?: AppAccess;
  landingPage?: AppLandingPage;
}

export interface PodMetric {
  name: string;
  cpu: string;
  memory: string;
}

export interface AppMetrics {
  available: boolean;
  pods: PodMetric[];
}

export interface Capabilities {
  appsDomain: string;
  sourceTypes: SourceType[];
  namespaces: string[];
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

export interface AnalyticsSummary {
  total: number;
  byPhase: Record<string, number>;
  bySourceType: Record<string, number>;
  byNamespace: Record<string, number>;
  readyReplicas: number;
  desiredReplicas: number;
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

export interface AppEvent {
  type: string;
  reason: string;
  message: string;
  kind: string;
  object: string;
  count: number;
  lastTimestamp: string;
}
